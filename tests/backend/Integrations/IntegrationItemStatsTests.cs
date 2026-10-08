using System.Linq.Expressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

public class IntegrationItemStatsTests
{
    [Theory]
    [InlineData(false, 25L, 100L, 25)]
    [InlineData(true, 0L, 100L, 100)]
    [InlineData(false, 150L, 100L, 100)]
    [InlineData(false, -20L, 100L, 0)]
    [InlineData(false, 20L, 0L, 0)]
    public void ProgressUsesUserScopedDataAndClampsToWholePercent(bool watched, long position, long runtime, int expected)
    {
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var item = new Audio { Id = Guid.NewGuid(), Size = 2048, RunTimeTicks = runtime };
        var data = new UserItemData { Key = "test", Played = watched, PlaybackPositionTicks = position };
        var manager = new Mock<IUserDataManager>();
#if NET10_0_OR_GREATER
        manager.Setup(m => m.GetUserDataBatch(It.IsAny<IReadOnlyList<BaseItem>>(), user)).Returns(new Dictionary<Guid, UserItemData> { [item.Id] = data });
#else
        manager.Setup(m => m.GetUserData(user, item)).Returns(data);
#endif
        var result = new ItemStatsService(Mock.Of<ILibraryManager>(), manager.Object).Compute(user, item, null);
        Assert.Equal(2048, result.Size); Assert.Equal(expected, result.Progress);
        Assert.Equal(runtime, result.TotalRuntimeTicks);
        Assert.Equal(watched ? runtime : position, result.TotalPlaybackTicks);
        manager.VerifyAll();
    }

    [Fact]
    public void FolderTraversalDeduplicatesLeavesAndCyclesAndIgnoresNonPlayableItems()
    {
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var item = new Audio { Id = Guid.NewGuid(), Size = 2048, RunTimeTicks = 100 };
        var folder = new Mock<Folder>(); folder.Object.Id = Guid.NewGuid();
        // Jellyfin 10 has additional optional arguments; describe the same
        // user-scoped call explicitly so Moq sees their real default values.
        var method = typeof(Folder).GetMethods().Single(m => m.Name == "GetChildren" && m.GetParameters().Length >= 2 && m.GetParameters()[0].ParameterType == typeof(User) && m.GetParameters()[1].ParameterType == typeof(bool) && m.GetParameters().Skip(2).All(p => p.IsOptional));
        var parameter = Expression.Parameter(typeof(Folder), "folder");
        var arguments = method.GetParameters().Select((p, i) => (Expression)Expression.Constant(i == 0 ? user : i == 1 ? true : p.DefaultValue, p.ParameterType));
        var children = Expression.Lambda<Func<Folder, IEnumerable<BaseItem>>>(Expression.Call(parameter, method, arguments), parameter);
        folder.Setup(children).Returns(new BaseItem[] { item, item, folder.Object, new Person { Id = Guid.NewGuid() } });
        var manager = new Mock<IUserDataManager>();
#if NET10_0_OR_GREATER
        manager.Setup(m => m.GetUserDataBatch(It.Is<IReadOnlyList<BaseItem>>(items => items.Count == 1 && items[0] == item), user)).Returns(new Dictionary<Guid, UserItemData>());
#endif
        var result = new ItemStatsService(Mock.Of<ILibraryManager>(), manager.Object).Compute(user, folder.Object, null);
        Assert.Equal(2048, result.Size); Assert.Equal(100, result.TotalRuntimeTicks);
        folder.Verify(children, Times.Once);
    }

    [Fact]
    public void SelectedMediaSourceControlsSizeCaseInsensitivelyWithoutChangingRuntime()
    {
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var item = new Audio { Id = Guid.NewGuid(), Size = 2048, RunTimeTicks = 100 };
        var manager = new Mock<IUserDataManager>();
#if NET10_0_OR_GREATER
        manager.Setup(m => m.GetUserDataBatch(It.IsAny<IReadOnlyList<BaseItem>>(), user)).Returns(new Dictionary<Guid, UserItemData>());
#endif
        var service = new ItemStatsService(Mock.Of<ILibraryManager>(), manager.Object);
        Assert.Equal(2048, service.Compute(user, item, item.Id.ToString("N").ToUpperInvariant()).Size);
        var missing = service.Compute(user, item, Guid.NewGuid().ToString("N"));
        Assert.Equal(0, missing.Size); Assert.Equal(100, missing.TotalRuntimeTicks); Assert.Equal(0, missing.Progress);
    }
}
