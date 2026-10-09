using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Library;
using Moq;
namespace JE.Tests;

[Collection("Plugin singleton")]
public class PosterSettingsProviderTests
{
    [Fact]
    public void Settings_save_invalidates_immediately_and_keeps_user_values_isolated()
    {
        using var f=new ApiPluginFixture();var users=new Mock<IUserManager>();using var provider=new PosterTagSettingsProvider(f.Core.Manager,new PosterTagUserCache(users.Object));
        var alice=Guid.NewGuid();var bob=Guid.NewGuid();
        f.Core.Manager.SaveUserConfiguration(alice.ToString("N"),"settings.json",new UserSettings{QualityTagsEnabled=true});
        var a=provider.Get(alice);var b=provider.Get(bob);Assert.True(a.QualityTagsEnabled);Assert.False(b.QualityTagsEnabled);Assert.Same(a,provider.Get(alice));
        f.Core.Manager.SaveUserConfiguration(alice.ToString("D").ToUpperInvariant(),"settings.json",new UserSettings{QualityTagsEnabled=false,GenreTagsEnabled=true});
        var changed=provider.Get(alice);Assert.NotSame(a,changed);Assert.False(changed.QualityTagsEnabled);Assert.True(changed.GenreTagsEnabled);Assert.NotEqual(a.Digest,changed.Digest);
        Assert.False(provider.Get(bob).GenreTagsEnabled);
    }
    [Fact]
    public void Unrelated_file_save_does_not_invalidate_snapshot_and_explicit_invalidation_reloads_hand_edit()
    {
        using var f=new ApiPluginFixture();using var provider=new PosterTagSettingsProvider(f.Core.Manager,new PosterTagUserCache(Mock.Of<IUserManager>()));var user=Guid.NewGuid();
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"settings.json",new UserSettings{QualityTagsEnabled=true});var before=provider.Get(user);
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"bookmarks.json",new {Bookmarks=new object[0]});Assert.Same(before,provider.Get(user));
        f.Core.Write(user.ToString("N"),"{\"QualityTagsEnabled\":false}");Assert.Same(before,provider.Get(user));provider.Invalidate(user);Assert.False(provider.Get(user).QualityTagsEnabled);
    }
    [Fact]
    public void Plugin_configuration_replacement_invalidates_admin_dependent_values()
    {
        using var f=new ApiPluginFixture();using var provider=new PosterTagSettingsProvider(f.Core.Manager,new PosterTagUserCache(Mock.Of<IUserManager>()));var user=Guid.NewGuid();var before=provider.Get(user);
        f.Plugin.UpdateConfiguration(new PluginConfiguration{NativePosterTagsEnabled=true,QualityTagsEnabled=true});var after=provider.Get(user);
        Assert.NotSame(before,after);Assert.True(after.NativeEnabled);Assert.True(after.QualityTagsEnabled);Assert.NotEqual(before.Digest,after.Digest);
    }
    [Fact]
    public void Current_user_audio_preference_changes_invalidate_effective_settings()
    {
        using var f=new ApiPluginFixture();var id=Guid.NewGuid();var user=new User("test","default","default"){Id=id,AudioLanguagePreference="eng"};var users=new Mock<IUserManager>();users.Setup(u=>u.GetUserById(id)).Returns(user);
        f.Core.Manager.SaveUserConfiguration(id.ToString("N"),"settings.json",new UserSettings{QualityTagsEnabled=true,QualityTagsPreferredAudioLanguage="auto"});using var provider=new PosterTagSettingsProvider(f.Core.Manager,new PosterTagUserCache(users.Object));
        var before=provider.Get(id);Assert.Equal("eng",before.PreferredAudioLanguage);user.AudioLanguagePreference="jpn";var after=provider.Get(id);Assert.Equal("jpn",after.PreferredAudioLanguage);Assert.NotEqual(before.Digest,after.Digest);
    }
    [Fact]
    public void User_cache_caches_missing_users_and_never_queries_empty_identity()
    {
        var users=new Mock<IUserManager>();var cache=new PosterTagUserCache(users.Object);var missing=Guid.NewGuid();Assert.Null(cache.Get(Guid.Empty));Assert.Null(cache.Get(missing));Assert.Null(cache.Get(missing));
        users.Verify(u=>u.GetUserById(missing),Times.Once);users.Verify(u=>u.GetUserById(Guid.Empty),Times.Never);
    }
}
