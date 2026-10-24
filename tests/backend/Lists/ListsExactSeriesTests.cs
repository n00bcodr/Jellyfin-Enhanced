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
    [Fact]
    public async Task RecoveryRecordsTheFirstLandedEpisodeBeforeItsAlternateIsPromoted()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("manager", collections: true);
        var list = h.Host.AddCollection();
        var series = h.Host.AddSeries(tmdb: 800);
        var firstPrimary = h.Host.AddEpisode(series, 1, 1);
        var first = h.Host.AddEpisode(series, 1, 1);
        var firstFacts = h.Host.Episodes.Single(e => e.Id == first);
        h.Host.MediaSources[firstPrimary] = new[] { new ListMediaSource(first, first.ToString("N"), 3840, 2160, true) };
        h.Host.Episodes.RemoveAll(e => e.Id == first);
        var secondPrimary = h.Host.AddEpisode(series, 1, 2);
        var second = h.Host.AddEpisode(series, 1, 2);
        h.Host.FourK.Add(first);
        h.Host.Episodes.RemoveAll(e => e.Id == second);
        // E1 was inserted as an alternate, then its HD primary disappeared before the first recovery pass.
        // There are now NO alternates and no fills. The durable intent and the collection are the only evidence.
        var ph = Ph("{\"kind\":\"series\",\"tmdbId\":800,\"title\":\"Show\",\"edition\":\"4k\"}", user.Id.ToString("N"));
        var doc = h.Store.LoadForUpdate(list.Info.Id.ToString("N"), ListKinds.Collection);
        doc.Items.Add(ph);
        doc.SwapIn = new ListConsent { ByUserId = user.Id.ToString("N"), At = DateTime.UtcNow.ToString("o") };
        list.Raw.Add(new RawEntry(first, true));
        doc.Intents.Add(new SwapIntent { PhId = ph.Id, ItemIds = new() { first.ToString("N") }, OccurrenceCountsBefore = new() { [first.ToString("N")] = 0 }, CreatedAt = DateTime.UtcNow.ToString("o") });
        h.Store.Save(doc);
        h.Host.Episodes.RemoveAll(e => e.Id == firstPrimary);
        h.Host.Items.Remove(firstPrimary);
        h.Host.MediaSources.Remove(firstPrimary);
        h.Host.Episodes.Add(firstFacts); // native promotion after the insert, before the first recovery pass
        h.Store.InvalidateAll(); // restart: only durable state survives

        await h.Swap.RunListPassAsync(doc.ListId, null, MetadataMode.None, default);
        var fill = Assert.Single(Assert.Single(h.Store.Load(doc.ListId)!.Items).Filled);
        Assert.Equal((first.ToString("N"), 1, 1), (fill.ItemId, fill.S, fill.E));
        Assert.Empty(h.Store.Load(doc.ListId)!.Intents);
        Assert.Equal(new[] { first }, h.Host.Resolved(list.Info.Id));
        Assert.DoesNotContain(h.Events.Pending(100), e => e.Complete);

        h.Store.InvalidateAll(); // another restart must preserve the representation
        h.Host.FourK.Add(second);
        h.Host.MediaSources[secondPrimary] = new[] { new ListMediaSource(second, second.ToString("N"), 3840, 2160, true) };
        await h.Swap.RunListPassAsync(doc.ListId, null, MetadataMode.None, default);
        Assert.Equal(new[] { first, second }, h.Host.Resolved(list.Info.Id));
        Assert.Equal(2, Assert.Single(h.Store.Load(doc.ListId)!.Items).Filled.Count);
    }

    [Fact]
    public async Task RecoveryKeepsTheCoordinatesTheIntentVerifiedWhenPromotionLosesNativeNumbers()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("manager", collections: true);
        var list = h.Host.AddCollection();
        var series = h.Host.AddSeries(tmdb: 800);
        var primary = h.Host.AddEpisode(series, 1, 1);
        var exact = h.Host.AddEpisode(series, 1, 1);
        var exactFacts = h.Host.Episodes.Single(e => e.Id == exact);
        h.Host.Episodes.RemoveAll(e => e.Id == exact);
        h.Host.FourK.Add(exact);
        h.Host.MediaSources[primary] = new[] { new ListMediaSource(exact, exact.ToString("N"), 3840, 2160, true) };
        var ph = Ph("{\"kind\":\"series\",\"tmdbId\":800,\"title\":\"Show\",\"edition\":\"4k\"}", user.Id.ToString("N"));
        var doc = h.Store.LoadForUpdate(list.Info.Id.ToString("N"), ListKinds.Collection);
        doc.Items.Add(ph);
        doc.SwapIn = new ListConsent { ByUserId = user.Id.ToString("N"), At = DateTime.UtcNow.ToString("o") };
        h.Store.Save(doc);
        ListDoc? beforeAcknowledgement = null;
        h.Host.AfterCollectionAdd = _ => beforeAcknowledgement = h.Store.Load(doc.ListId);
        await h.Swap.RunListPassAsync(doc.ListId, null, MetadataMode.None, default);
        h.Host.AfterCollectionAdd = null;
        // Keep the actual persisted pre-write intent, with only Jellyfin's insert surviving the crash.
        Assert.Single(beforeAcknowledgement!.Intents);
        h.Store.Save(beforeAcknowledgement);
        h.Host.Items.Remove(primary);
        h.Host.Episodes.RemoveAll(e => e.Id == primary);
        h.Host.MediaSources.Remove(primary);
        h.Host.Episodes.Add(exactFacts);
        h.Host.EpisodeCoordinatesMissing.Add(exact); // Jellyfin 12.2's promotion can clear both numbers
        h.Store.InvalidateAll();

        await h.Swap.RunListPassAsync(doc.ListId, null, MetadataMode.None, default);

        var fill = Assert.Single(Assert.Single(h.Store.Load(doc.ListId)!.Items).Filled);
        Assert.Equal((exact.ToString("N"), 1, 1), (fill.ItemId, fill.S, fill.E));
        Assert.Equal(new[] { exact }, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Store.Load(doc.ListId)!.Intents);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ExactSeriesEpisodesStayPendingAndRetryRejectedAndLaterArrivals(bool recoverIntent, bool lastArrivesAsPrimary)
    {
        using var h = new ListsHarness(seerr: true);
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
        ReconcileSeries(placeholder, 3);
        h.AnswerSeries(placeholder, 3);
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
        Assert.Single(h.Store.Load(doc.ListId)!.Items); // fills alone cannot replace fresh provider confirmation
        Assert.Empty(h.SeerrCalls);
        await h.Swap.DrainAsync(default);
        Assert.Contains("/api/v1/tv/800/season/1", h.SeerrCalls);
        Assert.Empty(h.Store.Load(doc.ListId)!.Items);
        Assert.Equal(new[] { first, second, third }, h.Host.Resolved(list.Info.Id));
    }
}
