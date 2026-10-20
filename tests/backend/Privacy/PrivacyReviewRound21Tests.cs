using System.Reflection;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Review round 21 (sites derived, not listed; policy fresh at emit; one derivation of the guarded set). Round 20's
/// constructions held for item DTOs, but one more output site built text from the original (the activity log named a
/// guarded title's extra by its own name, D46-R21-1); the tag cache emitted bytes under a policy read before it waited
/// for the shared serialization (D46-R21-2); and full loads and deltas derived the guarded set with different rules, so an
/// unchanged delta never matched a full load and a movie's extra kept its old text after watched → unwatched (D46-R21-3).
/// Uses only the filters' and endpoints' existing surface, so the same file runs against the pre-fix build.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound21Tests
{
    private static Guid Role(string role) => PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R21-1: every output path that reads an item's own text goes through the construction table.

    [Fact]
    public void NoOutputPathReadsItemTextOutsideTheConstructionTable()
    {
        var sites = PrivacyOutputPathScan.Sites();
        Assert.True(sites.Count == 0, sites.Count + " item-text reads on a protected item's output path outside PrivacyValues:\n"
            + string.Join("\n", sites.GroupBy(s => s.Where).Select(g => g.Key + ": " + string.Join(", ", g.Select(s => s.What).Distinct()))));
    }

    /// <summary>A verdict's output path that names an item from its own text (the shape of D46-R21-1), outside the plugin.</summary>
    private static class PlantedSite
    {
        public static string Activity(Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerUserResolver resolver, Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur state,
            Jellyfin.Plugin.JellyfinEnhanced.Services.PrivacyIdentity identity, BaseItem item)
            => resolver.InSpoilerScope(state, identity) ? Label(item) : "an item";

        private static string Label(BaseItem item) => "Playing " + item.Name;
    }

    [Fact]
    public void TheScanFindsAnItemTextReadOnAVerdictsOutputPath()
    {
        // The scan is derived from IL: a verdict asked in one method and the item's name read in a method it calls.
        var root = typeof(PlantedSite).GetMethod(nameof(PlantedSite.Activity))!;
        var sites = PrivacyOutputPathScan.Sites([root], typeof(PlantedSite).Assembly);
        Assert.Contains(sites, s => s.Method.Name == "Label" && s.Read.Name == "get_Name");
        Assert.Contains(root, PrivacyOutputPathScan.Roots(typeof(PlantedSite).Assembly));
    }

    [Theory]
    [InlineData("rule")]
    [InlineData("none")]
    public async Task AGuardedTitlesExtraIsNamedByItsKindInTheActivityLog(string mode)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        if (mode == "rule") rig.Commit(Rule("sg-series"), rig.Admin);
        var extra = Role("extra:showVideo:0");
        var video = (Video)rig.Items[extra];
        video.Name = "The Death of Alice explained r22";
        video.ExtraType = ExtraType.ThemeVideo;
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == "ActivityLog.GetLogEntries.json");
        var answer = (MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>)PrivacyHostShapeModelTests.Value(shot);
        var entry = answer.Items.First();
        entry.ItemId = extra.ToString("N");
        entry.Name = "real-admin is playing The Death of Alice explained r22";
        entry.Type = "VideoPlayback";
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        if (mode == "rule")
        {
            Assert.DoesNotContain("Death of Alice", body, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("laying Theme video", body, StringComparison.Ordinal);
        }
        else
        {
            Assert.Contains("real-admin is playing The Death of Alice explained r22", body, StringComparison.Ordinal);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R21-2: the policy is fresh at emit: re-read after every wait before bytes (or a 304) leave.

    private static readonly FieldInfo _serializationGate = typeof(JellyfinEnhancedController).GetField("_tagCacheSerializationGate", BindingFlags.NonPublic | BindingFlags.Static)!;

    /// <summary>
    /// Runs one tag-cache request while the shared serialization is held by someone else, applies
    /// <paramref name="change"/> once the request waits for it, then lets it through.
    /// </summary>
    private static async Task<(int Status, string Body, string? ETag)> WhileTheSerializationWaits(PrivacyReviewRound19Tests.TagSite site, Action change, string? ifNoneMatch = null)
    {
        var gate = (SemaphoreSlim)_serializationGate.GetValue(null)!;
        Assert.True(gate.Wait(TimeSpan.FromSeconds(30)), "the serialization gate is free");
        (int, string, string?) answer = default;
        Exception? failed = null;
        var thread = new Thread(() =>
        {
            try { answer = site.TagCacheResponse(ifNoneMatch: ifNoneMatch).GetAwaiter().GetResult(); }
            catch (Exception ex) { failed = ex; }
        });
        try
        {
            thread.Start();
            var until = DateTime.UtcNow.AddSeconds(10);
            while (!thread.ThreadState.HasFlag(ThreadState.WaitSleepJoin) && thread.IsAlive && DateTime.UtcNow < until) Thread.Sleep(5);
            Thread.Sleep(150);
            Assert.True(thread.IsAlive, "the request waits for the shared serialization");
            change();
        }
        finally
        {
            gate.Release();
        }
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)), "the request finished");
        if (failed != null) throw failed;
        return answer;
    }

    [Fact]
    public async Task EnablingSpoilerGuardWhileAFullLoadWaitsDeliversNoProtectedText()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, extras: true);
        var (status, body, _) = await WhileTheSerializationWaits(site, () => site.Guard(site.Series));
        Assert.Equal(200, status);
        var leaked = site.Sentinels.In(body).Where(p => p.StartsWith("episode", StringComparison.Ordinal) || p.StartsWith("seriesExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + leaked.Count + " guarded members delivered, e.g. " + string.Join(", ", leaked.Take(20)));
        Assert.Contains(site.Episode.ToString("N"), body, StringComparison.Ordinal);
    }

    private static readonly MethodInfo _clearShared = typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.TagCacheService).GetMethod("ClearSerializedItems", BindingFlags.NonPublic | BindingFlags.Instance)!;

    [Fact]
    public async Task ARevalidationIsNeverAnswered304ForBytesBuiltBeforeThePolicyChanged()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, extras: true);
        var (_, open, etag) = await site.TagCacheResponse();
        Assert.False(string.IsNullOrEmpty(etag));
        Assert.Contains(site.Sentinels.Planted.Keys, k => open.Contains(k, StringComparison.Ordinal));
        // The next full load serializes again (the shared copy is gone, as after a cache mutation).
        _clearShared.Invoke(site.Cache, null);
        var (status, body, fresh) = await WhileTheSerializationWaits(site, () => site.Guard(site.Series), ifNoneMatch: etag);
        Assert.Equal(200, status);
        Assert.NotEqual(etag, fresh);
        var leaked = site.Sentinels.In(body).Where(p => p.StartsWith("episode", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + string.Join(", ", leaked.Take(20)));
    }

    [Fact]
    public async Task APosterDrawnWhileSpoilerGuardIsEnabledIsDrawnAgainUnderTheNewPolicy()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true);
        var logger = site.Fixture.Core.Logger;
        var provider = new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagDataProvider(site.Cache, site.Library.Object, site.Stripper, site.Resolver,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagReviewRatings(site.Fixture.Core.Manager, new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagUserCache(site.Users.Object), logger), logger);
        var composer = new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagComposer(provider,
            Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.CompositeImageCache.Create(null, 1 << 20, 0, 1, TimeSpan.FromSeconds(5), _ => { }),
            Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(new Microsoft.Extensions.DependencyInjection.ServiceCollection()));
        var settings = Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagSettings.Create(null, site.Fixture.Plugin.Configuration);
        // The base image arrives while the viewer turns Spoiler Guard on for the series (nothing to draw on it, so the
        // answer says only which data it was drawn from).
        var loading = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrive = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        var image = new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagBaseImage("image/jpeg", "r22", () => { loading.TrySetResult(); return arrive.Task; });
        var http = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        var compose = composer.ComposeAsync(http, site.Items[site.Episode], site.Alice, settings, false, image, 90, useCache: false, CancellationToken.None);
        await loading.Task.WaitAsync(TimeSpan.FromSeconds(10));
        site.Guard(site.Series);
        arrive.SetResult([]);
        var result = await compose.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(result.SpoilerStripped, "the poster's tags come from the guarded episode's stripped data");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R21-3: one derivation of the guarded set for full loads and deltas.

    private static string FilterRevision(string body) => JsonNode.Parse(body)!["filterRevision"]!.ToString();

    private static JsonObject? Entry(string body, Guid id) => JsonNode.Parse(body)!["items"]?[id.ToString("N")] as JsonObject;

    [Fact]
    public async Task AnUnchangedDeltaKeepsTheFullLoadsFilterRevision()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var (_, full, _) = await site.TagCacheResponse();
        var (_, delta, _) = await site.TagCacheResponse(since: 150);
        Assert.Equal(FilterRevision(full), FilterRevision(delta));
        // The guarded series' extra rides with the delta, stripped like on the full load.
        Assert.NotNull(Entry(delta, site.SeriesExtra));
        var leaked = site.Sentinels.In(delta).Where(p => p.StartsWith("seriesExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "delta: " + string.Join(", ", leaked.Take(20)));
        Assert.Equal(JsonNode.Parse(full)!["items"]![site.SeriesExtra.ToString("N")]!.ToJsonString(), Entry(delta, site.SeriesExtra)!.ToJsonString());
    }

    [Fact]
    public async Task AGuardedMoviesExtraFollowsWatchedThenUnwatchedInDeltas()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true, guardMovie: true);
        bool Leaks(string body) => site.Sentinels.In(body).Any(p => p.StartsWith("movieExtraEntry", StringComparison.Ordinal));
        var (_, full, _) = await site.TagCacheResponse();
        Assert.False(Leaks(full), "an unwatched guarded movie's extra is stripped");
        var revision = FilterRevision(full);

        // Watched: the extra's own values return in the next delta, and the client keeps its copy (no full download).
        site.Played.Add(site.Movie);
        var (_, watched, _) = await site.TagCacheResponse(since: 150);
        Assert.Equal(revision, FilterRevision(watched));
        Assert.NotNull(Entry(watched, site.MovieExtra));
        Assert.True(Leaks(watched), "a watched movie's extra keeps its values");

        // Unwatched again: the delta strips the client's copy of the extra, still without a full download.
        site.Played.Remove(site.Movie);
        var (_, unwatched, _) = await site.TagCacheResponse(since: 150);
        Assert.Equal(revision, FilterRevision(unwatched));
        Assert.NotNull(Entry(unwatched, site.MovieExtra));
        Assert.False(Leaks(unwatched), "the extra is stripped again in the delta");
    }

    [Fact]
    public async Task AnOwnerLeavingTheGuardInvalidatesItsDependents()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var (_, full, _) = await site.TagCacheResponse();
        // A delta cannot restore the values a client's stored copy lost, so the filter revision changes: a full download.
        site.Unguard(site.Series);
        var (_, delta, _) = await site.TagCacheResponse(since: 150);
        Assert.NotEqual(FilterRevision(full), FilterRevision(delta));
        var (_, reload, _) = await site.TagCacheResponse();
        Assert.Equal(FilterRevision(reload), FilterRevision(delta));
        Assert.Contains(site.Sentinels.Planted.Keys, k => reload.Contains(k, StringComparison.Ordinal));
    }
}
