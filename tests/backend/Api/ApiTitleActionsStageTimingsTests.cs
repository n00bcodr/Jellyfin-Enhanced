using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

public partial class ApiTitleActionsTests
{
    private async Task<(int Status, string Body)> ReadOnce(Rig rig, Jellyfin.Database.Implementations.Entities.User viewer, string type, int tmdb, int? season, int? episode)
    {
        var route = new TitleActionsController(rig.Feeds, rig.Policy, rig.Callers.Users.Object)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(viewer) } } };
        var result = await route.Read(type, tmdb, season, episode);
        return (Status(result), result is ObjectResult o ? JsonSerializer.Serialize(o.Value) : string.Empty);
    }

    [Theory]
    [InlineData("movie", 693134, null, null)]
    [InlineData("tv", 83867, null, null)]
    [InlineData("tv", 83867, 1, null)]
    [InlineData("tv", 83867, 1, 2)]
    [InlineData("tv", 83867, 1, 999)]
    [InlineData("tv", 83867, 2, null)]
    public async Task StageTimingsLeaveTheAdmissionAnswerUnchangedAndNameOnlyStages(string type, int tmdb, int? season, int? episode)
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var plain = await Task.Run(() => ReadOnce(rig, viewer, type, tmdb, season, episode));
        var (recorder, timed) = await Task.Run(async () =>
        {
            var r = StageTimings.Begin();
            return (r, await ReadOnce(rig, viewer, type, tmdb, season, episode));
        });

        // Same status and body, in the same order of checks, whether or not the request is timed.
        Assert.Equal(plain, timed);
        // The real copy is looked up before the metadata read and again for the final answer.
        Assert.Equal(plain.Status == 200 ? 2 : 1, recorder.Of(Stage.Copies).Count);
        Assert.True(recorder.Of(Stage.Policy).Count >= 1);
        Assert.Equal(1, recorder.Of(Stage.Feed).Count);
        if (plain.Status == 200) Assert.Equal(1, recorder.Of(Stage.Project).Count);
        Assert.Equal(episode == null ? 0 : 1, recorder.Of(Stage.Parse).Count);

        var header = recorder.Header();
        Assert.Matches("^total;dur=[0-9]+\\.[0-9](, [a-z-]+;dur=[0-9]+\\.[0-9];desc=\"n=[0-9]+\")*$", header);
        Assert.DoesNotContain(viewer.Id.ToString("N"), header, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(viewer.Id.ToString(), header, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture), header, StringComparison.Ordinal);
        Assert.DoesNotContain("Series", header, StringComparison.Ordinal);
        Assert.DoesNotContain("Movie", header, StringComparison.Ordinal);
    }

    [Fact]
    public async Task StageTimingsAreOffByDefaultAndRecordNothing()
    {
        Assert.False(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration().StageTimingsEnabled);
        using var rig = new Rig();
        var viewer = rig.Person();
        var inside = await Task.Run(async () =>
        {
            using (StageTimings.Time(Stage.Policy)) StageTimings.Count(Stage.MetaHit);
            await ReadOnce(rig, viewer, "movie", 693134, null, null);
            return StageTimings.Current;
        });
        Assert.Null(inside);
    }
}
