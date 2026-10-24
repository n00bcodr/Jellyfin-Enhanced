using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationD46ParentArtworkTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void SelectedParentArtworkRefreshRevokesTheOldAnswerAndItsResizeCache(bool compareProof)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var episode = rig.Items.Values.OfType<Episode>().First();
        var parent = rig.Items[episode.SeriesId];
        var path = Path.Combine(rig.F.Core.Root, "parent.jpg");
        File.WriteAllBytes(path, PosterBlurTests.Source());
        parent.ImageInfos = [new ItemImageInfo {Type=ImageType.Backdrop, Path=path, DateModified=DateTime.UtcNow}];
        using var next = new SpoilerNextUnwatchedService(rig.Library.Object, rig.Users.Object, rig.UserData.Object, rig.F.Core.Logger);
        using var filter = new SpoilerBlurImageFilter(rig.Library.Object, rig.Users.Object, rig.UserData.Object, Mock.Of<IChapterManager>(),
            null!, new ImageBlurService(rig.F.Core.Logger), next, rig.F.Core.Logger);
        var method = typeof(SpoilerBlurImageFilter).GetMethod("TryGetParentArtBytes", BindingFlags.NonPublic | BindingFlags.Instance)!;
        byte[] Answer() => Assert.IsType<byte[]>(method.Invoke(filter, [episode, new UserSpoilerBlur(), PosterBlurTests.Source(), "same-route"]));
        using var scope = PrivacyReadSet.Begin();
        var before = Answer();
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        File.WriteAllBytes(path, PosterBlurTests.Source(inverse: true));
        if (compareProof) Assert.False(scope.Reads.Valid());
        else Assert.False(before.SequenceEqual(Answer()), "The selected new parent bytes must not reuse the old resized image");
    }
}
