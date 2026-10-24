#pragma warning disable ASPDEPR004, ASPDEPR008
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationD46Round26InputSoundnessTests
{
    private static Guid Role(string role) => Guid.Parse(PrivacyHostShapeModelTests.Data.Roles[role]);

    [Theory]
    [InlineData("counts")]
    [InlineData("number")]
    public async Task NativeSeasonAnswerCannotUseOldCountsOrNumbering(string stale)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), rig.Admin);
        var season = (Season)rig.Items[Role("season:show-s1")];
        season.IndexNumber = 2;
        rig.Played.Clear();
        const string sentinel = "protected season overview from before the refresh";
        using var server = new TestServer(new WebHostBuilder().ConfigureServices(s => s.AddLogging().AddControllers()).Configure(app => app.Run(async http =>
        {
            http.User = TestCallers.Principal(rig.Admin, true);
            var action = new ActionContext(http, new RouteData(), new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "TvShows", ["action"] = "GetSeasons" } }, new ModelStateDictionary());
            var gate = rig.Gate(); gate.OnResourceExecuting(new ResourceExecutingContext(action, [], []));
            var dto = new BaseItemDto { Id = season.Id, Type = BaseItemKind.Season, SeriesId = season.SeriesId,
                IndexNumber = stale == "number" ? 1 : 2, Name = "Old season name", Overview = sentinel,
                RecursiveItemCount = stale == "counts" ? 1 : null,
                UserData = stale == "counts" ? new UserItemDataDto { Key = "k", UnplayedItemCount = 0 } : null };
            var delivering = new ResultExecutingContext(action, [], new ObjectResult(new QueryResult<BaseItemDto>([dto])), new object());
            gate.OnResultExecuting(delivering);
            await delivering.Result.ExecuteResultAsync(action);
            await PrivacyResponseGuard.CommitAsync(http);
        })));
        using var client = server.CreateClient(); using var response = await client.GetAsync("/");
        var body = await response.Content.ReadAsStringAsync();
        Assert.False(body.Contains(sentinel), "Native season answer retained protected overview using stale " + stale + ", HTTP " + (int)response.StatusCode);
    }
}
