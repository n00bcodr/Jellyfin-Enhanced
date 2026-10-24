using System.Collections;
using System.Reflection;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiSeerrDerivedFactTests
{
    private static async Task Warm(IntegrationNotificationsTests.Rig r)
    {
        r.Config.ArrRequestBackend = "seerr"; r.Config.ArrBackendIsolationVersion = 1;
        r.Request(1, 693134, r.Emma);
        Assert.True(await r.Requests.RefreshAsync(default));
    }
    [Fact]
    public async Task SerializedStatusCacheCannotHandOutSeerrBytesUnderTheirOldKeyAfterAdoption()
    {
        using var r = new IntegrationNotificationsTests.Rig(); await Warm(r);
        var body = await r.Status.ForBatchAsync(r.Emma, [], [TitleKey.Parse("movie:tmdb:693134")!], default);
        var map = (IDictionary)typeof(ArrStatusCache).GetField("_map", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(r.Status.Cache)!;
        var keys = map.Keys.Cast<string>().ToArray(); Assert.NotEmpty(keys);
        Assert.Contains(keys, key => r.Status.Cache.Get(key) != null);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Config.ArrRequestBackend = "je", default);
        Assert.All(keys, key => Assert.Null(r.Status.Cache.Get(key)));
        // A purely local answer has no Seerr dependency and keeps identical bytes/ETag.
        var local = r.Status.Cache.Put("local-answer", body.Json);
        Assert.Same(local, r.Status.Cache.Get("local-answer"));
    }
    [Fact]
    public async Task CachedFeedAudienceVerdictRetainsItsSeerrDependencyEvenIfTheCallerReusesItsStamp()
    {
        using var r = new IntegrationNotificationsTests.Rig(); await Warm(r);
        r.Config.ArrPhase3Enabled = false;
        var person = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = r.Emma.UserId };
        person.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        var library = new Mock<ILibraryManager>(); library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<BaseItem>());
        var audience = new ArrFeedAudience(library.Object, Mock.Of<IUserManager>(), r.Store, () => r.Arr.Now, r.View, r.Requests);
        var cached = typeof(ArrFeedAudience).GetMethod("Cached", BindingFlags.Instance | BindingFlags.NonPublic)!;
        object? Read() => cached.Invoke(audience, [person, "movie:tmdb:693134", null, r.Arr.Now, "same-caller-stamp"]);
        Assert.Equal("Visible", Read()!.ToString());
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Config.ArrRequestBackend = "je", default);
        Assert.NotEqual("Visible", Read()!.ToString());
    }
    [Fact]
    public async Task CachedNotificationInterestCannotScheduleSeerrOnlyTitlesAfterAdoption()
    {
        using var r = new IntegrationNotificationsTests.Rig(); await Warm(r);
        r.Service.RebuildInterest();
        ((IDictionary)typeof(NotificationService).GetField("_dirty", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(r.Service)!).Clear();
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Config.ArrRequestBackend = "je", default);
        r.Service.Observe(["movie:tmdb:693134"]);
        Assert.False(r.Service.HasDirty("movie:tmdb:693134"));
    }
    [Fact]
    public async Task NotificationProcessingRetainsItsFactAdmissionBeyondAnAwaitAndDrainsBeforeAdoption()
    {
        using var r = new IntegrationNotificationsTests.Rig();
        r.Config.ArrRequestBackend = "seerr"; r.Config.ArrBackendIsolationVersion = 1;
        r.Request(1, 693134, r.Emma, status: SeerrRequestStatus.Pending);
        Assert.True(await r.Requests.RefreshAsync(default));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var policy = new Mock<IRequestPolicy>();
        policy.Setup(p => p.PrepareVisibilityAsync(It.IsAny<Guid>(), It.IsAny<MutationInput>(), It.IsAny<CancellationToken>()))
            .Returns(async (Guid _, MutationInput _, CancellationToken ct) => { entered.TrySetResult(); await release.Task; ct.ThrowIfCancellationRequested(); });
        using var service = new NotificationService(r.NotifyStore, r.Status, r.Requests, r.View, r.Feed, r.Store, r.Users, r.Dispatcher, null, null, () => r.Config, () => r.Arr.Now, r.Hub, r.Bridge, policy: policy.Object);
        var work = service.TickAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // Production uses the singleton owner; this fixture supplies an explicit-config owner.
        var field = r.Requests.GetType().GetField("_owner", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? r.Requests.GetType().GetField("_backend", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var owner = (EffectiveRequestsBackend)field.GetValue(r.Requests)!;
        var committed = false;
        var transition = owner.TransitionAsync(() => { r.Config.ArrRequestBackend = "je"; committed = true; }, default);
        var committedBeforeProcessingEnded = committed;
        release.TrySetResult();
        var failure = await Record.ExceptionAsync(() => work.WaitAsync(TimeSpan.FromSeconds(10)));
        await transition.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.False(committedBeforeProcessingEnded);
        Assert.IsAssignableFrom<OperationCanceledException>(failure);
    }
}
