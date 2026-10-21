using System.Diagnostics;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Xunit.Abstractions;
using static JE.Tests.ListsImportReviewR2FixTests;
using static JE.Tests.ListsSourceReviewR3FixTests;

namespace JE.Tests;

// Track 4c2a review round 5 (D53, each rule closed at its edges). Rule 1: an outstanding reservation (reserved, not yet
// counted by MDBList) survives a status refresh: spendable = what MDBList reports − every outstanding reservation, so a
// refresh that overtakes a request in flight never gives its request back (4c2-R5-1: 6 → A reserved (5) → a refresh says
// 6 → B reserved → MDBList at 4). Rule 2 (absent ≠ present-but-invalid) is the row table in ListsSourceReviewR3FixTests.
// Rule 3: a definitive lookup outcome (NotFound) is cached with its status and a cache hit never waits for the limiter,
// so successive budgeted reviews of a list with a stale prefix advance (4c2-R5-4). Rule 4: every field of a preview entry
// a provider can fill with title-level content goes through the viewer's Spoiler Guard projection, on ordinary and exact
// previews (4c2-R5-2: an IMDb episode title in an ordinary entry's note).
[Collection("Plugin singleton")]
public class ListsSourceReviewR5FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;

    // ── Rule 1: an outstanding reservation survives a refresh ─────────

    private const string SingleRoute = "https://api.mdblist.com/tmdb/movie/42";
    private const string BatchRoute = "https://api.mdblist.com/tmdb/movie/";
    private const string ListA = "https://api.mdblist.com/lists/me/a/items";

    // MDBList at `start`, counting a request when it ANSWERS it (a request in flight isn't in its count yet).
    private static (Net Net, Func<int> Counted) QuotaCountedOnAnswer(int start)
    {
        var counted = 0;
        var net = MdblistApiNet(() => start - Volatile.Read(ref counted));
        foreach (var route in new[] { SingleRoute, BatchRoute, ListA, "https://api.mdblist.com/lists/me/b/items", "https://api.mdblist.com/lists/me/c/items" })
        {
            Func<HttpRequestMessage, HttpResponseMessage> answer = net.Routes.TryGetValue(route, out var listAnswer) ? listAnswer : _ => Json(route == BatchRoute ? "[]" : "{\"ratings\":[],\"ids\":{\"tmdb\":42}}");
            net.Routes[route] = r =>
            {
                var response = answer(r);
                Interlocked.Increment(ref counted);
                return response;
            };
        }

        return (net, () => Volatile.Read(ref counted));
    }

    private static async Task<bool> SpendAsync(Net net, string kind) => kind switch
    {
        "list" => (await net.Fetch("https://mdblist.com/lists/me/b", ApiRead)).Ok,
        "single" => await SingleSentAsync(net),
        _ => await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None) != null,
    };

    private static async Task<bool> SingleSentAsync(Net net)
    {
        var before = net.Sent(SingleRoute);
        await net.Quota.GetRatingsAsync("movie", "42", None);
        return net.Sent(SingleRoute) > before;
    }

    [Theory]
    [InlineData("list")]
    [InlineData("single")]
    [InlineData("batch")]
    public async Task ARefreshThatOvertakesAReservationInFlightNeverLetsASecondRequestSpendPastTheMargin(string second)
    {
        var (net, counted) = QuotaCountedOnAnswer(MdblistService.SafetyMargin + 1);
        using var _ = net;
        Assert.Equal(MdblistService.SafetyMargin + 1, (await net.Quota.GetAccountStatusAsync(None))!.RateLimitRemaining);
        var listA = net.Routes[ListA];
        var arrived = false;
        using var release = new ManualResetEventSlim();
        net.Routes[ListA] = r =>
        {
            Volatile.Write(ref arrived, true);
            release.Wait(TimeSpan.FromSeconds(10)); // A is on its way: MDBList hasn't counted it
            return listA(r);
        };

        var a = Task.Run(() => net.Fetch("https://mdblist.com/lists/me/a", ApiRead)); // reserves 6 → 5
        await WaitUntil(() => Volatile.Read(ref arrived));
        var refreshed = await net.Quota.GetAccountStatusAsync(None, forceRefresh: true); // MDBList still says 6
        var sent = await SpendAsync(net, second);
        release.Set();

        Assert.True((await a).Ok);
        Assert.False(sent, second + " was sent while A was outstanding: MDBList ends at " + (MdblistService.SafetyMargin + 1 - counted()));
        Assert.Equal(1, counted());
        Assert.Equal(MdblistService.SafetyMargin, refreshed!.RateLimitRemaining); // 6 reported − A outstanding
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    [Fact] // green before and after: a request answered before the refresh was asked for is in MDBList's count, once
    public async Task AReservationAnsweredBeforeARefreshIsCountedOnlyOnce()
    {
        var (net, counted) = QuotaCountedOnAnswer(MdblistService.SafetyMargin + 2);
        using var _ = net;

        Assert.True((await net.Fetch("https://mdblist.com/lists/me/a", ApiRead)).Ok); // 7 → 6, answered: MDBList at 6
        Assert.Equal(MdblistService.SafetyMargin + 1, (await net.Quota.GetAccountStatusAsync(None, forceRefresh: true))!.RateLimitRemaining);
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/b", ApiRead)).Ok); // 6 → 5
        Assert.False((await net.Fetch("https://mdblist.com/lists/me/c", ApiRead)).Ok);

        Assert.Equal(2, counted());
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    [Fact] // a reservation whose request fails stays charged until a status read asked after it says otherwise
    public async Task AReservationWhoseRequestFailedStaysChargedUntilALaterRefresh()
    {
        var (net, counted) = QuotaCountedOnAnswer(MdblistService.SafetyMargin + 2);
        using var _ = net;
        net.Routes[ListA] = _ => throw new HttpRequestException("connection reset"); // MDBList never counted it

        Assert.False((await net.Fetch("https://mdblist.com/lists/me/a", ApiRead)).Ok); // 7 → 6 (charged)
        Assert.Equal(MdblistService.SafetyMargin + 1, net.Quota.RemainingQuota());
        Assert.Equal(MdblistService.SafetyMargin + 2, (await net.Quota.GetAccountStatusAsync(None, forceRefresh: true))!.RateLimitRemaining); // asked after: 7
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/b", ApiRead)).Ok); // 7 → 6
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/c", ApiRead)).Ok); // 6 → 5
        Assert.Equal(2, counted());
    }

    // ── Rule 3: definitive lookups are cached with their status; a cache hit skips the limiter ──

    [Fact]
    public async Task AStalePrefixLongerThanOneBudgetIsPassedBySuccessiveReviews()
    {
        // 60 ids TMDB no longer knows (404) before 10 good ones; one review completes about 24 lookups (4 at once, 25 ms apart).
        var limiter = new MetadataCallLimiter(4, TimeSpan.FromMilliseconds(25), TimeProvider.System);
        using var w = new ListsSourceReviewR4FixTests.CompletionWorld(70, limiter);
        w.Preview.CompletionBudget = TimeSpan.FromMilliseconds(600); // r4-seam
        w.Answer = id => id <= 60 ? 404 : 200;

        var reviews = new List<int>();
        SourceFetchResponse? last = null;
        for (var review = 0; review < 8 && (last == null || last.CountsHidden == true); review++)
        {
            (last, _) = await w.Fetch();
            reviews.Add(last.Entries.Count);
        }

        output.WriteLine("entries per review: " + string.Join(", ", reviews) + "; TMDB calls " + w.Starts.Count);
        Assert.Equal(70, last!.Entries.Count);
        Assert.NotEqual(true, last.CountsHidden);
        Assert.True(reviews.Count <= 5, "reviews: " + string.Join(", ", reviews));
        Assert.Equal(w.Starts.Count, w.Starts.Distinct().Count()); // every id was asked once: a NotFound is remembered
    }

    [Fact]
    public async Task ACachedNotFoundAnswersWithoutWaitingForTheLimiterAndKeepsItsStatus()
    {
        var limiter = new MetadataCallLimiter(1, TimeSpan.Zero, TimeProvider.System);
        using var w = new ListsSourceReviewR4FixTests.CompletionWorld(1, limiter);
        w.Answer = _ => 404;
        var lookup = new TmdbImportLookup(w.Tmdb, limiter, w.H.Plugin.Core.Logger);
        var context = new ImportCallContext("me", false);

        Assert.Equal(LookupStatus.NotFound, (await lookup.GetDetailsAsync("movie", 7, context, None)).Status);
        using (await limiter.AcquireAsync("someone else", false, None)) // the limiter is full
        {
            var again = lookup.GetDetailsAsync("movie", 7, context, None);
            Assert.True(await Task.WhenAny(again, Task.Delay(TimeSpan.FromSeconds(5))) == again, "a remembered NotFound waited for the limiter");
            Assert.Equal(LookupStatus.NotFound, (await again).Status);
        }

        Assert.Single(w.Starts);
    }

    [Fact] // green before and after: a transient failure is never remembered
    public async Task ATransientLookupFailureStaysRetryable()
    {
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        using var w = new ListsSourceReviewR4FixTests.CompletionWorld(4, limiter);
        var failing = true;
        w.Answer = id => id == 3 && Volatile.Read(ref failing) ? 503 : 200;

        var (first, _) = await w.Fetch();
        Volatile.Write(ref failing, false);
        var (second, _) = await w.Fetch();

        Assert.Equal(new[] { 1, 2, 4 }, first.Entries.Select(e => e.Ids!.Tmdb!.Value).ToArray());
        Assert.True(first.CountsHidden);
        Assert.Equal(4, second.Entries.Count);
        Assert.NotEqual(true, second.CountsHidden);
    }

    // ── Rule 4: every field a provider can fill with title-level content is guarded ──

    // Every field of a preview entry a provider fills with title-level text, as the spoiler it would carry.
    private const string EpisodeNote = "The Rains of Castamere";
    private const string MovieNote = "It was all a dream";
    private const string EpisodeTitle = "Spoiler episode";
    private const string SeasonName = "Spoiler season";
    private const string Overview = "Spoiler overview";

    private static string[] Spoilers => new[] { EpisodeNote, MovieNote, EpisodeTitle, SeasonName, Overview };

    // An IMDb list (ordinary): an episode row whose note is the episode's title, and a Trakt-style movie row with a note.
    private static List<SourceItem> OrdinaryRows() => new()
    {
        new SourceItem("tv", 1399, "tt0944947", null, "Game of Thrones", 2011, 3, 9, EpisodeNote),
        new SourceItem("movie", 27205, null, null, "Inception", 2010, null, null, MovieNote),
    };

    // A watch order (exact): a run of episodes and a movie, with the metadata Chronolists publishes, and notes.
    private static List<SourceItem> ExactRows() => new()
    {
        new SourceItem("tv", 1399, null, null, "Game of Thrones", 2011, 3, 1, EpisodeNote) { Details = new SourceItemDetails(EpisodeTitle, "2013-03-31", null, null, SeasonName) },
        new SourceItem("tv", 1399, null, null, "Game of Thrones", 2011, 3, 2, null) { Details = new SourceItemDetails(EpisodeTitle, "2013-04-07", null, null, SeasonName) },
        new SourceItem("movie", 27205, null, null, "Inception", 2010, null, null, MovieNote) { Details = new SourceItemDetails(null, "2010-07-16", null, Overview, null) },
    };

    [Theory]
    [InlineData("ordinary", true)]
    [InlineData("ordinary", false)]
    [InlineData("exact", true)]
    [InlineData("exact", false)]
    public async Task EveryTitleLevelFieldOfAPreviewEntryGoesThroughSpoilerGuard(string kind, bool guarded)
    {
        using var h = new ImportHarness();
        var viewer = h.NewUser("viewer");
        var other = h.NewUser("other");
        h.Fetcher.Exact = kind == "exact";
        h.Fetcher.Provider = kind == "exact" ? "chronolists" : "imdb";
        h.Fetcher.Items = kind == "exact" ? ExactRows() : OrdinaryRows();
        var url = kind == "exact" ? "https://chronolists.com/got" : "https://www.imdb.com/list/ls000000302/";
        if (guarded)
        {
            h.Viewer.Guard(viewer, "tv", 1399);
            h.Viewer.Guard(viewer, "movie", 27205);
        }

        var fetched = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(viewer, url, None));
        var json = JsonSerializer.Serialize(fetched);
        // The same (shared, cached) source rows, read by someone who guards nothing: the guard never changed them.
        var unguarded = JsonSerializer.Serialize(ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(other, url, None)));

        var fields = Fields(fetched).ToList();
        output.WriteLine(kind + " guarded=" + guarded + ": " + string.Join("; ", fields.Select(f => f.Name + "=" + (f.Value ?? "null"))));
        Assert.NotEmpty(fields);
        foreach (var (name, value) in fields)
        {
            if (guarded)
            {
                Assert.True(value == null, kind + ": " + name + " shows '" + value + "' to a viewer who guards the title");
            }
            else
            {
                Assert.True(value != null, kind + ": " + name + " was stripped for a viewer who doesn't guard the title");
            }
        }

        foreach (var spoiler in Spoilers.Where(s => unguarded.Contains(s, StringComparison.Ordinal)))
        {
            Assert.Equal(!guarded, json.Contains(spoiler, StringComparison.Ordinal));
        }

        Assert.Contains(EpisodeNote, unguarded, StringComparison.Ordinal);
        Assert.Equal(EpisodeNote, h.Fetcher.Items[0].Note); // the source row itself is never changed
        if (kind == "exact")
        {
            Assert.Equal(EpisodeTitle, h.Fetcher.Items[0].Details!.EpisodeTitle);
        }
    }

    // The inventory: every field of an entry (and its prepared resolution) a provider fills with title-level text.
    private static IEnumerable<(string Name, string? Value)> Fields(SourceFetchResponse response)
    {
        foreach (var entry in response.Entries)
        {
            var at = entry.TypeHint + " " + entry.Index;
            if (entry.Note != null || HasNote(entry))
            {
                yield return (at + " note", entry.Note);
            }

            if (entry.Prepared?.Match is { } match)
            {
                if (match.MediaType == "movie")
                {
                    yield return (at + " overview", match.Overview);
                }

                if (match.Season != null)
                {
                    yield return (at + " season name", match.Season.Name);
                }

                foreach (var episode in match.Episodes ?? new List<ImportEpisodeInfoDto>())
                {
                    yield return (at + " episode " + episode.E + " title", episode.Title);
                }
            }
        }

        // A note that was carried by the source row (the first entry of each title carries one).
        static bool HasNote(ImportEntryDto entry) => entry.Index == 0 || entry.TypeHint == "movie";
    }
}
