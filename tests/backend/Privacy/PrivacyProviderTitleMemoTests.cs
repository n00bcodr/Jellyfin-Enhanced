using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

/// <summary>
/// Spoiler Guard's memo of an item's TMDB key (provider intent: a title guarded before it had a copy) is a library fact
/// remembered for 30 s. A key read while the item changed is never remembered (before: the change's event dropped the memo,
/// then the read in flight put the old key back, and the title stayed unguarded for up to 30 s), and a change announced
/// after the read applies at once.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyProviderTitleMemoTests
{
    [Fact]
    public void AKeyReadWhileTheItemChangedIsReadAgainAndALaterChangeAppliesAtOnce()
    {
        using var core = new CoreFixture();
        var id = Guid.NewGuid();
        Movie Copy(string tmdb)
        {
            var movie = new Movie { Id = id, Name = "Movie" };
            movie.SetProviderId(MetadataProvider.Tmdb, tmdb);
            return movie;
        }

        var library = new Mock<ILibraryManager>();
        var current = Copy("1");
        var raceDuringRead = true;
        library.Setup(l => l.GetItemById(id)).Returns(() =>
        {
            var seen = current;
            if (raceDuringRead)
            {
                // The item is identified while this read is in flight: its update is announced before the read returns.
                raceDuringRead = false;
                current = Copy("603");
                library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = current });
            }

            return seen;
        });
        var users = Mock.Of<IUserManager>();
        var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), users, new SpoilerIdentityService(users, core.Logger), core.Logger);
        var resolver = new SpoilerUserResolver(core.Manager, library.Object, core.Logger, identities);
        var state = new UserSpoilerBlur();
        state.ProviderTitles["movie:tmdb:603"] = new();

        // Judged by what the read saw (TMDB 1) ...
        Assert.False(resolver.IsMovieInSpoilerScope(state, id));
        // ... but not remembered: the next check reads the identified item and guards it.
        Assert.True(resolver.IsMovieInSpoilerScope(state, id));
        Assert.True(resolver.IsMovieInSpoilerScope(state, id));

        // A change announced after the read (nothing in flight) applies to the very next check.
        current = Copy("1");
        library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = current });
        Assert.False(resolver.IsMovieInSpoilerScope(state, id));
    }
}
