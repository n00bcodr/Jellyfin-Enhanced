using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Activity;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Identity;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.Activity;

/// <summary>
/// The Activity feed applies the viewer's Spoiler Guard the way the other rows JE builds do: an unwatched episode
/// of a guarded series is listed without its title, and reviews of a guarded title are not shown.
/// </summary>
[Collection("Plugin singleton")]
public class ActivitySpoilerGuardTests
{
    private sealed class Lab : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public User Viewer { get; } = new("viewer", "default", "default") { Id = Guid.NewGuid() };
        public User Author { get; } = new("author", "default", "default") { Id = Guid.NewGuid() };
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<IItemRepository> Repository { get; } = new();
        public Series Show { get; } = new() { Id = Guid.NewGuid(), Name = "Show" };
        public Movie Film { get; } = new() { Id = Guid.NewGuid(), Name = "Film" };
        public Episode Watched { get; }
        public Episode Unwatched { get; }
        public PluginConfiguration Config => Plugin.Plugin.Configuration;
        private readonly SpoilerSeerrRedactor redactor;

        public Lab()
        {
            Config.ActivityFeedEnabled = true;
            Config.SpoilerBlurEnabled = true;
            // Stored reviews reach the feed only while user reviews are switched on.
            Config.ShowUserReviews = true;
            Users.Setup(u => u.GetUserById(Viewer.Id)).Returns(Viewer);
            Users.Setup(u => u.GetUserById(Author.Id)).Returns(Author);
            Show.ProviderIds["Tmdb"] = "1433";
            Film.ProviderIds["Tmdb"] = "550";
            Watched = Episode(1, "Pilot");
            Unwatched = Episode(2, "The one where the hero dies");
            foreach (var item in new BaseItem[] { Show, Film, Watched, Unwatched })
                Library.Setup(l => l.GetItemById(item.Id)).Returns(item);
            // Every item is in a library the viewer may open; access is not what this test is about.
            Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds.ToList());
            // The viewer has seen the pilot and not the second episode.
            Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.ParentId == Show.Id && q.IsPlayed == null))).Returns([Watched, Unwatched]);
            Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.ParentId == Show.Id && q.IsPlayed == true))).Returns([Watched]);
            Repository.Setup(r => r.GetItemIdsList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                q.HasAnyProviderId.GetValueOrDefault("Tmdb") switch { "1433" => [Show.Id], "550" => [Film.Id], _ => [] });

            var manager = Plugin.Core.Manager;
            manager.RecordActivity(Author.Id.ToString("N"), Watched.Id.ToString("N"), "Watched", "2026-11-01T10:00:00Z", completed: true, progress: 1);
            manager.RecordActivity(Author.Id.ToString("N"), Unwatched.Id.ToString("N"), "Watched", "2026-11-01T11:00:00Z", completed: true, progress: 1);
            manager.UpsertReview(Author.Id.ToString("N"), "tv", "1433", "Shocked that the hero dies", 2, "2026-11-01T12:00:00Z");
            manager.UpsertReview(Author.Id.ToString("N"), "movie", "550", "Great film", 5, "2026-11-01T13:00:00Z");

            var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), Users.Object,
                new SpoilerIdentityService(Users.Object, Plugin.Core.Logger, Plugin.Core.Paths.Object), Plugin.Core.Logger);
            var resolver = new SpoilerUserResolver(manager, Library.Object, Plugin.Core.Logger, identities);
            var data = new Mock<IUserDataManager>();
            redactor = new SpoilerSeerrRedactor(resolver, Library.Object, Users.Object, data.Object,
                new SpoilerNextUnwatchedService(Library.Object, Users.Object, data.Object, Plugin.Core.Logger));
        }

        private Episode Episode(int number, string name) => new()
        {
            Id = Guid.NewGuid(), Name = name, SeriesId = Show.Id, SeriesName = Show.Name, ParentIndexNumber = 1, IndexNumber = number
        };

        /// <summary>Turns Spoiler Guard on for the series, through the production save path.</summary>
        public void GuardShow(SpoilerBlurUserPrefs? prefs = null)
        {
            var state = new UserSpoilerBlur { Prefs = prefs ?? new() };
            state.Series[Show.Id.ToString("N")] = new();
            Plugin.Core.Manager.SaveUserConfiguration(Viewer.Id.ToString("N"), "spoilerblur.json", state);
        }

        /// <summary>GET /JellyfinEnhanced/activity as the viewer: each row as "type|item name|review text".</summary>
        public List<string> Feed()
        {
            var controller = (JeActivityController)ApiAssetTests.Controller(typeof(JeActivityController), Plugin.Core,
                Library.Object, Users.Object, Plugin.Core.Manager, Repository.Object, redactor);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", Viewer.Id.ToString()), new Claim(ClaimTypes.Role, "User")], "test"));
            var body = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(controller.GetActivityFeed()).Value);
            return body.GetProperty("items").EnumerateArray().Select(row =>
                $"{row.GetProperty("ActivityType").GetString()}|{row.GetProperty("Item").GetProperty("Name").GetString()}|{row.GetProperty("Content").GetString()}").ToList();
        }

        public void Dispose() => Plugin.Dispose();
    }

    [Fact]
    public void AGuardedSeriesKeepsItsUnwatchedEpisodeTitlesAndReviewsOutOfTheFeed()
    {
        using var lab = new Lab();
        lab.GuardShow();

        Assert.Equal(
        [
            "Reviewed|Film|Great film",
            "Watched|Season 1, Episode 2|",
            "Watched|Pilot|",
        ], lab.Feed());
    }

    [Fact]
    public void ASeriesWithoutProviderIdsIsMatchedByItsLibraryItem()
    {
        using var lab = new Lab();
        lab.Show.ProviderIds.Clear();
        lab.GuardShow();

        Assert.Contains("Watched|Season 1, Episode 2|", lab.Feed());
        Assert.DoesNotContain("Watched|The one where the hero dies|", lab.Feed());
    }

    [Fact]
    public void WithoutSpoilerGuardOrWithItsTogglesOffTheFeedIsUnchanged()
    {
        using var lab = new Lab();
        string[] whole =
        [
            "Reviewed|Film|Great film",
            "Reviewed|Show|Shocked that the hero dies",
            "Watched|The one where the hero dies|",
            "Watched|Pilot|",
        ];
        Assert.Equal(whole, lab.Feed());

        // The viewer's own opt-outs from title replacement and review hiding.
        lab.GuardShow(new SpoilerBlurUserPrefs { ReplaceEpisodeTitles = false, HideReviews = false });
        Assert.Equal(whole, lab.Feed());

        // The administrator's switches.
        lab.GuardShow();
        lab.Config.SpoilerReplaceTitle = false;
        lab.Config.SpoilerStripReviews = false;
        Assert.Equal(whole, lab.Feed());
    }
}
