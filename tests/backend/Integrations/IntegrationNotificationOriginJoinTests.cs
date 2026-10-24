using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using World = JE.Tests.ReadyProvenanceAndWaitsTests.World;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationNotificationOriginJoinTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AJeApprovalWithBoundedCopiesPreservesItsNoticeAndOriginalDeadline(bool expires)
    {
        using var w = new World(await IntegrationNotificationsTests.Started(), jeMode: true);
        await w.Ask(w.Rig.Kid, "movie:tmdb:7100", "bounded-copy-origin");
        w.Policy.Adjust = (user, input, facts) =>
        {
            if (user == w.Rig.Admin.UserId && input.Key == "movie:tmdb:7100")
            {
                CopyLookupBound.Note();
                return facts with { Visible = false };
            }
            return facts;
        };
        var original = w.Rig.Arr.Now;
        await w.Step(false);
        Assert.Equal(0, w.Rows(w.Rig.Admin, NotifyKind.Approval));
        Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM request_notices WHERE kind='create'"));
        w.Rig.Arr.Now += NotifyDispatcher.BoundRetry + TimeSpan.FromMinutes(1);
        await w.Step(false);
        Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM request_notices WHERE kind='create'"));

        w.Rig.Arr.Now = expires ? original + NotifyDispatcher.WaitAtMost + TimeSpan.FromMinutes(1)
            : w.Rig.Arr.Now + NotifyDispatcher.BoundRetry + TimeSpan.FromMinutes(1);
        if (!expires) w.Policy.Adjust = null;
        await w.Step(false);
        Assert.Equal(expires ? 0 : 1, w.Rows(w.Rig.Admin, NotifyKind.Approval));
        Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM request_notices"));
        w.Policy.Adjust = null;
        await w.Step(false);
        Assert.Equal(expires ? 0 : 1, w.Rows(w.Rig.Admin, NotifyKind.Approval));
    }
}
