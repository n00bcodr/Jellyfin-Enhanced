using System.Diagnostics;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;

namespace JE.Tests;

// Review round 1 (track x): the single-flight sync slot is freed before the sync's task completes, so a sync requested
// right after the previous one finished runs anew instead of getting the finished run's result back.
[Collection("Plugin singleton")]
public class ListPlaceholdersSyncReviewR1xTests
{
    [Fact]
    public async Task ASyncRequestedAsSoonAsThePreviousOneFinishedRunsAnew()
    {
        using var h = new ListPlaceholdersHarness();
        h.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
        var owner = h.NewUser("owner");
        var list = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        h.Lookup.Details[("movie", 1)] = new TitleDetails(FakeImportLookup.Movie(1, "Movie 1", "2020-01-01"), null, null, "Released", null, Array.Empty<SeasonFacts>());
        h.Fetcher.Items = [new SourceItem("movie", 1, null, null, "Movie 1", 2020, null, null, null)];
        var linked = await h.Sources.LinkAsync(access, new LinkSourceRequest { Url = "https://mdblist.com/lists/me/dc", SyncEnabled = true }, CancellationToken.None);
        Assert.Equal(200, linked.StatusCode);
        h.Fetcher.OnFetch = () => Task.Delay(1); // every sync finishes on another thread

        var fetches = h.Fetcher.Calls.Count;
        var stale = 0;
        for (var i = 0; i < 200; i++)
        {
            var previous = h.Sources.SyncAsync(access.ListIdN, background: true, CancellationToken.None);
            var watch = Stopwatch.StartNew();
            while (!previous.IsCompleted && watch.Elapsed < TimeSpan.FromSeconds(10))
            {
                // Spin: ask again the moment the previous sync's result is out, like a caller awaiting it would.
            }

            Assert.True(previous.IsCompleted);
            var next = h.Sources.SyncAsync(access.ListIdN, background: true, CancellationToken.None);
            if (ReferenceEquals(previous, next))
            {
                stale++;
            }

            Assert.Equal("ok", (await next).State);
        }

        Assert.Equal(0, stale);
        Assert.Equal(fetches + 400, h.Fetcher.Calls.Count); // every sync fetched
    }
}
