using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using N = JE.Tests.IntegrationNotificationsTests;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationEvidenceOrderingTests
{
    private static JfSource Quality(JfSource source, int width, int height) => new()
    { SourceId = source.SourceId, ItemId = source.ItemId, BackingItemId = source.BackingItemId, Path = source.Path, DateCreated = source.DateCreated, Width = width, Height = height };

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task FollowAndItsLifecycleOrderEveryMovieAndEpisodeObservation(bool movie, bool unfollow)
    {
        var (r, title, item, before) = await IntegrationEditionEvidenceTests.OldHd(movie);
        using var rig = r;
        using var release = new ManualResetEventSlim();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pause = 1;
        using var service = new NotificationService(r.NotifyStore, r.Status, r.Requests, r.View, r.Feed, r.Store, r.Users, r.Dispatcher, null, null, () => r.Config, () => r.Arr.Now, r.Hub, r.Bridge);
        service.BaselinesCaptured = () =>
        {
            if (Interlocked.Exchange(ref pause, 0) == 1)
            { reached.TrySetResult(); Assert.True(release.Wait(TimeSpan.FromSeconds(10))); }
        };
        service.RebuildInterest();
        r.View.SourcesByItem[item][0] = Quality(before, 1280, 720); r.View.Rev++;
        var old = movie
            ? Task.Run(async () => { Assert.Equal("ok", await service.SetFollowAsync(r.Emma, title, true, default)); })
            : Task.Run(() => service.EvaluateAsync(new[] { title.ToString() }, r.Emma.UserId, default));
        Task next;
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            r.View.SourcesByItem[item][0] = Quality(before, 3840, 2160); r.View.Rev++;
            next = unfollow ? service.SetFollowAsync(r.Emma, title, false, default) : service.TickAsync(default, force: true);
            await Task.Delay(50);
            Assert.False(next.IsCompleted);
        }
        finally { release.Set(); }
        await Task.WhenAll(old, next).WaitAsync(TimeSpan.FromSeconds(10));
        var scope = movie ? "m4k" : "eps4k";
        if (unfollow)
        {
            Assert.Null(r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), scope + "|sources"));
            if (movie) Assert.Equal("ok", await service.SetFollowAsync(r.Emma, title, true, default));
            else
            {
                // An explicit series follow observes every edition (no eps4k baseline). Removing its mute
                // re-creates the requested 4K interest and must not revive the old evaluator's evidence.
                r.NotifyStore.SetFollow(r.Emma.UserId, title.ToString(), "episodes", false, true, r.Arr.Now);
                await service.EvaluateAsync(new[] { title.ToString() }, r.Emma.UserId, default);
            }
        }
        else
        {
            await service.EvaluateAsync(new[] { title.ToString() }, null, default);
            r.Arr.Now = r.Arr.Now.AddMinutes(11); service.FlushBatches(r.Arr.Now);
            Assert.Single(r.Inbox(r.Emma));
        }
        Assert.Contains("3840x2160", r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), scope + "|sources")?.Known ?? "");
        // A later real downgrade/removal remains observable; ordering is not a maximum-quality or history-union rule.
        r.View.SourcesByItem[item][0] = Quality(before, 1280, 720); r.View.Rev++;
        await service.EvaluateAsync(new[] { title.ToString() }, null, default);
        var downgraded = r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), scope + "|sources")?.Known ?? "";
        Assert.Contains("1280x720", downgraded); Assert.DoesNotContain("3840x2160", downgraded);
        r.View.SourcesByItem[item].Clear(); r.View.Rev++;
        await service.EvaluateAsync(new[] { title.ToString() }, null, default);
        Assert.DoesNotContain("1280x720", r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), scope + "|sources")?.Known ?? "");
    }
    [Fact]
    public async Task AStandaloneWriterForkedFromAnEvaluatorStillWaitsForTheObservationToCommit()
    {
        var (r, title, _, _) = await IntegrationEditionEvidenceTests.OldHd(true);
        using var rig = r;
        using var release = new ManualResetEventSlim();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task? writer = null; var once = 0;
        using var service = new NotificationService(r.NotifyStore, r.Status, r.Requests, r.View, r.Feed, r.Store, r.Users, r.Dispatcher, null, null, () => r.Config, () => r.Arr.Now, r.Hub, r.Bridge);
        service.BaselinesCaptured = () =>
        {
            if (Interlocked.Exchange(ref once, 1) != 0) return;
            writer = Task.Run(() => service.Store.DeleteWatch(r.Emma.UserId, title.ToString()));
            reached.TrySetResult(); Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
        };
        var evaluation = Task.Run(() => service.SetFollowAsync(r.Emma, title, true, default));
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5)); await Task.Delay(50);
            Assert.NotNull(writer); Assert.False(writer!.IsCompleted);
        }
        finally { release.Set(); }
        await evaluation; await writer!.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), "m4k|sources"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AStandaloneTestNotificationCannotBypassItsForkedEvaluator(bool limited)
    {
        using var r = await N.Started();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<bool>? send = null;
        var held = r.NotifyStore.Ordering.RunAsync(async () =>
        {
            send = Task.Run(() => limited ? r.Service.TrySendTest(r.Emma.UserId, TimeSpan.Zero) : r.Service.SendTest(r.Emma.UserId));
            entered.TrySetResult();
            await release.Task;
        }, default);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Task.Delay(50);
            Assert.NotNull(send);
            Assert.False(send!.IsCompleted);
            Assert.Empty(r.Inbox(r.Emma));
        }
        finally { release.TrySetResult(); }
        await held.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(await send!.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Single(r.Inbox(r.Emma), n => n.Kind == NotifyKind.Test);
    }

}
