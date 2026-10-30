using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class AwardQuotaTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ChartAndRatingBatchShareTheReserveBoundary(bool chartFirst)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.MdblistApiKey = "fixture-only";
        config.AwardsTagsEnabled = true;
        config.MdblistFetchReserve = 100;
        config.AwardsTagsLetterboxd = config.AwardsTagsCertifiedFresh = config.AwardsTagsOscar = config.AwardsTagsEmmy = false;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requests = 0;
        using var transport = new IntegrationTransport(async (request, token) => {
            if (request.RequestUri!.AbsolutePath == "/user")
                return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":101}");
            Interlocked.Increment(ref requests);
            entered.TrySetResult();
            await release.Task.WaitAsync(token);
            return IntegrationTransport.Response(request.Method == HttpMethod.Get ? "{\"movies\":[]}" : "[]");
        });
        using var mdblist = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        using var wiki = new WikidataAwardsService(transport, f.Core.Paths.Object, f.Core.Logger);
        var awards = new AwardTagsService(transport, f.Core.Paths.Object, mdblist, wiki, f.Core.Logger);
        Task Chart() => awards.RefreshAsync([("movie", "42")], config, null, default);
        Task Batch() => mdblist.WarmTagRatingsAsync([("movie", "43")], default, 100);
        var first = chartFirst ? Chart() : Batch();
        Task second;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            second = chartFirst ? Batch() : Chart();
            Assert.False(second.IsCompleted);
            Assert.Equal(1, Volatile.Read(ref requests));
        }
        finally { release.TrySetResult(); }
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, requests);
        Assert.Equal(100, mdblist.RemainingQuota());
        Assert.Equal(chartFirst, mdblist.NeedsFetch("movie", "43"));
    }

    [Theory]
    [InlineData(503, true, false)]
    [InlineData(503, false, true)]
    [InlineData(503, true, true)]
    [InlineData(429, true, true)]
    public async Task UnknownQuotaSendsNeitherChartsNorCertificationAndLeavesRetryableFacts(int status, bool charts, bool certification)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.MdblistApiKey = "fixture-only";
        config.AwardsTagsEnabled = true;
        config.AwardsTagsImdb = config.AwardsTagsLetterboxd = charts;
        config.AwardsTagsCertifiedFresh = certification;
        config.AwardsTagsOscar = config.AwardsTagsEmmy = false;
        var requests = 0;
        using var transport = new IntegrationTransport((request, _) => {
            if (request.RequestUri!.AbsolutePath == "/user") return Task.FromResult(IntegrationTransport.Response("{}", status));
            Interlocked.Increment(ref requests);
            return Task.FromResult(IntegrationTransport.Response("[]"));
        });
        using var mdblist = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        using var wiki = new WikidataAwardsService(transport, f.Core.Paths.Object, f.Core.Logger);
        var awards = new AwardTagsService(transport, f.Core.Paths.Object, mdblist, wiki, f.Core.Logger);
        await awards.RefreshAsync([("movie", "42")], config, null, default);
        Assert.Equal(0, requests);
        Assert.Null(mdblist.GetCachedEntry("movie", "42"));
        Assert.True(mdblist.NeedsFetch("movie", "42"));
        var disk = JsonSerializer.Deserialize<AwardTagsService.Disk>(File.ReadAllText(Path.Combine(f.Core.ConfigRoot, "award-tags.json")))!;
        Assert.All(disk.Lists.Values, list => Assert.False(list.Confirmed));
        var deadline = DateTimeOffset.FromUnixTimeMilliseconds(Assert.Single(disk.Titles).Value.NextRefresh);
        Assert.InRange((deadline - DateTimeOffset.UtcNow).TotalMinutes, 55, 65);
        Assert.Null(awards.GetCached("movie", "42", config)!.ImdbRank);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AccountStatusCannotPublishInsideAChartRequestOrRestoreItsSpend(bool statusStartedBeforeChart)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistApiKey = "fixture-only";
        var chartEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseChart = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var userEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseUser = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var users = 0;
        var requests = 0;
        using var transport = new IntegrationTransport(async (request, token) => {
            if (request.RequestUri!.AbsolutePath == "/user")
            {
                if (Interlocked.Increment(ref users) == 2)
                {
                    userEntered.SetResult();
                    await releaseUser.Task.WaitAsync(token);
                }
                return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":101}");
            }
            Interlocked.Increment(ref requests);
            chartEntered.TrySetResult();
            await releaseChart.Task.WaitAsync(token);
            return IntegrationTransport.Response("{\"movies\":[]}");
        });
        using var mdblist = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        await mdblist.GetAccountStatusAsync(default);
        Task<MdblistAccountStatus?>? status = statusStartedBeforeChart ? mdblist.GetAccountStatusAsync(default, forceRefresh: true) : null;
        if (status != null) await userEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var chart = mdblist.GetAwardListWithinReserveAsync("123", 100, default);
        try
        {
            await chartEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            status ??= mdblist.GetAccountStatusAsync(default, forceRefresh: true);
            await userEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            releaseUser.TrySetResult();
            Assert.False(status.IsCompleted);
        }
        finally { releaseUser.TrySetResult(); releaseChart.TrySetResult(); }
        Assert.NotNull(await chart.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(100, (await status.WaitAsync(TimeSpan.FromSeconds(5)))!.RateLimitRemaining);
        Assert.Equal(100, mdblist.RemainingQuota());
        Assert.Null(await mdblist.GetAwardListWithinReserveAsync("456", 100, default));
        var batch = await mdblist.GetMediaBatchWithinReserveAsync("movie", ["43"], 100, default);
        Assert.Equal(MdblistReservedBatchStatus.ReserveReached, batch.Status);
        Assert.Equal(1, requests);
    }
}
