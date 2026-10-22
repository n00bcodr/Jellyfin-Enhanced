using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using P = JE.Tests.IntegrationEditionPressTests;
namespace JE.Tests;
[Collection("Plugin singleton")]
public class IntegrationEditionReservationTests
{
    [Fact]
    public async Task AnAskAlreadyPreparingAndASearchCannotBothUseOneRetryId()
    {
        using var p = new P.PressRig(seerr: false);
        var title = TitleKey.Parse("tv:tvdb:78874")!;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        p.Policy.Before = async (_, _) => { entered.TrySetResult(); await resume.Task; };
        var askTask = p.Requests.CreateAsync(p.Rig.Admin.UserId, new CreateRequest("same-concurrent", new MutationInput { Key = title.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1,3) } }), default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var instance = p.Rig.Arr.Instance("Sonarr4kZ").Id;
        var search = await p.Manage.SearchCheckedAsync(p.Rig.Admin, null, instance, title.WithEpisode(1,2), "same-concurrent", default);
        resume.SetResult();
        var ask = await askTask;
        var sent = p.Rig.Sonarr4k!.Writes.Count(w => w.Path == "/api/v3/command");
        var wants = p.Ledger.ForTitle(title.ToString()).Count;
        Assert.False(sent > 0 && wants > 0, $"one retry id: search={search.Outcome.Status}, sends={sent}, ask={ask.HttpStatus}/{ask.Reason}, wants={wants}");
    }
}
