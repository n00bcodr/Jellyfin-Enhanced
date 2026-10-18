using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 6 (4c1-r6-behaviour-1): a 4K whole-series collection entry whose 4K episodes are alternates of HD primaries
// resolves to the exact Episode items. It fills episode by episode (a Series link would lose the version), keeps standing
// until the series completion rule holds, and retries an episode Jellyfin refused, also once later 4K episodes arrive as
// primaries.
[Collection("Plugin singleton")]
public class ListsExactSeriesTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ExactSeriesEpisodesStayPendingAndRetryRejectedAndLaterArrivals(bool recoverIntent, bool lastArrivesAsPrimary)
    {
        using var h = new ListsHarness();
        var user = h.NewUser("manager", collections: true);
        var list = h.Host.AddCollection();
        var series = h.Host.AddSeries(tmdb: 800);
        var primary = h.Host.AddEpisode(series, 1, 1);
        var first = h.Host.AddEpisode(series, 1, 1);
        var secondPrimary = h.Host.AddEpisode(series, 1, 2);
        var second = h.Host.AddEpisode(series, 1, 2);
        var thirdPrimary = h.Host.AddEpisode(series, 1, 3);
        var third = h.Host.AddEpisode(series, 1, 3);
        h.Host.FourK.UnionWith(new[] { first, second, third });
        h.Host.MediaSources[primary] = new[] { new ListMediaSource(first, first.ToString("N"), 3840, 2160, true) };
        h.Host.MediaSources[secondPrimary] = new[] { new ListMediaSource(second, second.ToString("N"), 3840, 2160, true) };
        h.Host.MediaSources[thirdPrimary] = Array.Empty<ListMediaSource>();
        h.Host.Episodes.RemoveAll(e => e.Id == first || e.Id == second || e.Id == third);
        var placeholder = Ph("{\"kind\":\"series\",\"tmdbId\":800,\"title\":\"Show\",\"edition\":\"4k\"}", user.Id.ToString("N"));
        placeholder.InProduction = false;
        placeholder.Expected = new() { new() { S = 1, E = 1, AirDate = "2000-01-01" }, new() { S = 1, E = 2, AirDate = "2000-01-02" }, new() { S = 1, E = 3, AirDate = "2000-01-03" } };
        var doc = h.Store.LoadForUpdate(list.Info.Id.ToString("N"), ListKinds.Collection);
        doc.Items.Add(placeholder);
        doc.SwapIn = new ListConsent { ByUserId = user.Id.ToString("N"), At = DateTime.UtcNow.ToString("o") };
        if (recoverIntent)
        {
            list.Raw.Add(new RawEntry(first, true));
            doc.Intents.Add(new SwapIntent { PhId = placeholder.Id, ItemIds = new() { first.ToString("N"), second.ToString("N") }, OccurrenceCountsBefore = new() { [first.ToString("N")] = 0, [second.ToString("N")] = 0 }, CreatedAt = DateTime.UtcNow.ToString("o") });
        }
        h.Store.Save(doc);
        h.Host.CollectionDrops.Add(second);
        await h.Swap.RunListPassAsync(doc.ListId, null, MetadataMode.None, default);
        var pending = Assert.Single(h.Store.Load(doc.ListId)!.Items);
        Assert.Equal(first.ToString("N"), Assert.Single(pending.Filled).ItemId);
        Assert.DoesNotContain(h.Events.Pending(100), e => e.Complete);
        h.Host.CollectionDrops.Clear();
        await h.Swap.RunListPassAsync(doc.ListId, null, MetadataMode.None, default);
        Assert.Equal(2, Assert.Single(h.Store.Load(doc.ListId)!.Items).Filled.Count);
        if (lastArrivesAsPrimary)
        {
            h.Host.MediaSources[primary] = Array.Empty<ListMediaSource>();
            h.Host.MediaSources[secondPrimary] = Array.Empty<ListMediaSource>();
            third = thirdPrimary;
        }
        h.Host.MediaSources[thirdPrimary] = new[] { new ListMediaSource(third, third.ToString("N"), 3840, 2160, true) };
        await h.Swap.RunListPassAsync(doc.ListId, null, MetadataMode.None, default);
        Assert.Empty(h.Store.Load(doc.ListId)!.Items);
        Assert.Equal(new[] { first, second, third }, h.Host.Resolved(list.Info.Id));
    }
}
