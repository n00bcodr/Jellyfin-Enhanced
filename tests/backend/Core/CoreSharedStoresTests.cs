using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Newtonsoft.Json;

namespace JE.Tests;

public class CoreSharedStoresTests
{
    [Fact]
    public void ReviewUpdatesPreserveCreationAndIsolateUserAndMediaKeys()
    {
        using var f = new CoreFixture();
        var events = 0;
        f.Manager.ReviewsChanged += () => events++;
        Assert.Null(f.Manager.UpsertReview("a", "movie", "1", "first", 4, "2020"));
        f.Manager.UpsertReview("b", "movie", "1", "other user", 2, "2020");
        f.Manager.UpsertReview("a", "tv", "1", "other media", 3, "2020");
        Assert.Equal(4, f.Manager.UpsertReview("a", "movie", "1", "edited", 5, "2021"));
        var reviews = f.Manager.GetAllReviews().Reviews;
        Assert.Equal(3, reviews.Count);
        Assert.Equal("2020", reviews["a:movie:1"].CreatedAt);
        Assert.Equal("2021", reviews["a:movie:1"].UpdatedAt);
        Assert.Equal("edited", reviews["a:movie:1"].Content);
        Assert.True(f.Manager.DeleteReview("a", "movie", "1", out var removed));
        Assert.Equal(5, removed);
        Assert.False(f.Manager.DeleteReview("a", "movie", "1", out _));
        Assert.Equal(5, events);
        Assert.Equal(2, f.Manager.GetAllReviews().Reviews.Count);
    }

    [Theory]
    [InlineData("")][InlineData("null")][InlineData("garbage")][InlineData("{}")][InlineData("{\"Reviews\":null}")][InlineData("{\"Reviews\":{\"a\":null}}")][InlineData("{\"Reviews\":{}} garbage")]
    public void CorruptReviewsCannotBeOverwritten(string content)
    {
        using var f = new CoreFixture();
        var path = Path.Combine(f.ConfigRoot, "reviews.json");
        File.WriteAllText(path, content);
        Assert.Empty(f.Manager.GetAllReviews().Reviews);
        Assert.ThrowsAny<Exception>(() => f.Manager.UpsertReview("a", "movie", "1", "new", 4, "2021"));
        Assert.Equal(content, File.ReadAllText(path));
        Assert.Equal(content, File.ReadAllText(Assert.Single(Directory.GetFiles(f.ConfigRoot, "reviews.json.corrupt-*"))));
    }

    [Fact]
    public void ConcurrentReviewWritesPreserveEveryUser()
    {
        using var f = new CoreFixture();
        Parallel.For(0, 40, i => f.Manager.UpsertReview(i.ToString(), "movie", "1", "review", 4, "2020"));
        Assert.Equal(40, f.Manager.GetAllReviews().Reviews.Count);
    }

    [Fact]
    public void WatchedActivityNeverDowngradesWhileFavoritesKeepOriginalTimestamp()
    {
        using var f = new CoreFixture();
        f.Manager.RecordActivity("u", "i", "Watched", "2020", true, 1);
        f.Manager.RecordActivity("u", "i", "Watched", "2021", false, .2);
        var watched = f.Manager.GetAllActivity().Entries["u:i:Watched"];
        Assert.True(watched.Completed);
        Assert.Equal(1, watched.Progress);
        Assert.Equal("2021", watched.OccurredAt);
        f.Manager.RecordActivity("u", "i", "Favorited", "2020");
        f.Manager.RecordActivity("u", "i", "Favorited", "2021");
        Assert.Equal("2020", f.Manager.GetAllActivity().Entries["u:i:Favorited"].OccurredAt);
        f.Manager.RemoveActivity("u", "i", "Favorited");
        f.Manager.RecordActivity("u", "i", "Favorited", "2022");
        Assert.Equal("2022", f.Manager.GetAllActivity().Entries["u:i:Favorited"].OccurredAt);
        Assert.Equal(2, f.Manager.GetAllActivity().Entries.Count);
    }

    [Theory]
    [InlineData("")][InlineData("null")][InlineData("{}")][InlineData("{\"Entries\":null}")]
    [InlineData("{\"Entries\":{\"a\":null}}")][InlineData("{\"Entries\":{}} garbage")]
    public void CorruptActivityReadIsLenientButMutationsPreserveOriginal(string content)
    {
        using var f = new CoreFixture();
        var path = Path.Combine(f.ConfigRoot, "activity.json");
        File.WriteAllText(path, content);
        Assert.Empty(f.Manager.GetAllActivity().Entries);
        Assert.ThrowsAny<Exception>(() => f.Manager.RecordActivity("u", "i", "Watched", "2020"));
        Assert.ThrowsAny<Exception>(() => f.Manager.RemoveActivity("u", "i", "Watched"));
        Assert.Equal(content, File.ReadAllText(path));
    }

    [Fact]
    public void ActivityRetentionDropsOldestAt500AndLeavesNoTemporaryFiles()
    {
        using var f = new CoreFixture();
        var store = new AllActivityStore();
        for (var i = 0; i < 500; i++) store.Entries[$"u:{i}:Watched"] = new ActivityEntry { OccurredAt = $"{i:D5}" };
        File.WriteAllText(Path.Combine(f.ConfigRoot, "activity.json"), JsonConvert.SerializeObject(store));
        f.Manager.RecordActivity("u", "new", "Watched", "99999");
        var result = f.Manager.GetAllActivity().Entries;
        Assert.Equal(500, result.Count);
        Assert.False(result.ContainsKey("u:0:Watched"));
        Assert.True(result.ContainsKey("u:new:Watched"));
        Assert.Empty(Directory.GetFiles(f.ConfigRoot, "*.tmp"));
    }

    [Fact]
    public void ProcessedWatchlistCleanupPersistsOnlyRecentRecordsAndIsUserIsolated()
    {
        using var f = new CoreFixture();
        var id = Guid.NewGuid();
        f.Manager.SaveProcessedWatchlistItems(id, new ProcessedWatchlistItems { Items = [
            new() { TmdbId = 1, ProcessedAt = DateTime.UtcNow.AddDays(-400) },
            new() { TmdbId = 2, ProcessedAt = DateTime.UtcNow.AddDays(-1) }
        ] });
        f.Manager.CleanupOldProcessedWatchlistItems(id);
        Assert.Equal(2, Assert.Single(f.Manager.GetProcessedWatchlistItems(id).Items).TmdbId);
        Assert.Empty(f.Manager.GetProcessedWatchlistItems(Guid.NewGuid()).Items);
    }
}
