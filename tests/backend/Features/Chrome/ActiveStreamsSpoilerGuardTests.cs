using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Chrome;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Identity;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests.Features.Chrome;

/// <summary>
/// JE's Active Streams list names what each session is playing. A caller who guards a series gets an unwatched
/// episode of it named as Jellyfin's own session list names it for them ("Season N, Episode M").
/// </summary>
[Collection("Plugin singleton")]
public class ActiveStreamsSpoilerGuardTests
{
    private sealed class Lab : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public User Viewer { get; } = new("admin", "default", "default") { Id = Guid.NewGuid() };
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<ISessionManager> Sessions { get; } = new();
        public Series Show { get; } = new() { Id = Guid.NewGuid(), Name = "Show" };
        public Episode Watched { get; }
        public Episode Unwatched { get; }
        public PluginConfiguration Config => Plugin.Plugin.Configuration;
        private readonly SpoilerSeerrRedactor redactor;

        public Lab()
        {
            Config.ActiveStreamsEnabled = true;
            Config.SpoilerBlurEnabled = true;
            Users.Setup(u => u.GetUserById(Viewer.Id)).Returns(Viewer);
            Watched = Episode(1, "Pilot");
            Unwatched = Episode(2, "The one where the hero dies");
            foreach (var item in new BaseItem[] { Show, Watched, Unwatched })
                Library.Setup(l => l.GetItemById(item.Id)).Returns(item);
            Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds.ToList());
            // The viewer has seen the pilot and not the second episode.
            Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.ParentId == Show.Id && q.IsPlayed == null))).Returns([Watched, Unwatched]);
            Library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.ParentId == Show.Id && q.IsPlayed == true))).Returns([Watched]);
            // Two other devices are playing the two episodes.
            Sessions.SetupGet(s => s.Sessions).Returns(new[] { Playing(Watched), Playing(Unwatched) });

            var identities = new RequestIdentityService(Sessions.Object, Users.Object,
                new SpoilerIdentityService(Users.Object, Plugin.Core.Logger, Plugin.Core.Paths.Object), Plugin.Core.Logger);
            var resolver = new SpoilerUserResolver(Plugin.Core.Manager, Library.Object, Plugin.Core.Logger, identities);
            var data = new Mock<IUserDataManager>();
            redactor = new SpoilerSeerrRedactor(resolver, Library.Object, Users.Object, data.Object,
                new SpoilerNextUnwatchedService(Library.Object, Users.Object, data.Object, Plugin.Core.Logger));
        }

        private Episode Episode(int number, string name) => new()
        {
            Id = Guid.NewGuid(), Name = name, SeriesId = Show.Id, SeriesName = Show.Name, ParentIndexNumber = 1, IndexNumber = number
        };

        private SessionInfo Playing(Episode episode) => new(Sessions.Object, NullLogger.Instance)
        {
            UserId = Guid.NewGuid(),
            UserName = "someone",
            NowPlayingItem = new BaseItemDto
            {
                Id = episode.Id, Type = BaseItemKind.Episode, Name = episode.Name, SeriesId = Show.Id, SeriesName = Show.Name,
                ParentIndexNumber = episode.ParentIndexNumber, IndexNumber = episode.IndexNumber
            }
        };

        public void GuardShow()
        {
            var state = new UserSpoilerBlur();
            state.Series[Show.Id.ToString("N")] = new();
            Plugin.Core.Manager.SaveUserConfiguration(Viewer.Id.ToString("N"), "spoilerblur.json", state);
        }

        /// <summary>GET /JellyfinEnhanced/active-streams/sessions as the administrator: the names of what is playing.</summary>
        public List<string?> Names()
        {
            var controller = (JeChromeController)ApiAssetTests.Controller(typeof(JeChromeController), Plugin.Core,
                Users.Object, Plugin.Core.Manager, Sessions.Object, redactor);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", Viewer.Id.ToString()), new Claim(ClaimTypes.Role, "Administrator")], "test"));
            var body = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(controller.GetActiveSessions()).Value);
            return body.EnumerateArray().Select(s => s.GetProperty("NowPlayingItem").GetProperty("Name").GetString()).ToList();
        }

        /// <summary>The same list as the bootstrap payload carries it.</summary>
        public List<string?> BootstrapNames()
        {
            var maintenance = new Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance.MaintenanceModeService(Users.Object, Sessions.Object, Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, maintenance, Plugin.Core.Manager, Users.Object, Sessions.Object, Library.Object, redactor);
            controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(Viewer.Id, true);
            var body = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Transport.BootstrapResponse>(Assert.IsType<JsonResult>(controller.GetBootstrap()).Value);
            return JsonSerializer.SerializeToElement(body.Prefetched!.ActiveStreamSessions).EnumerateArray()
                .Select(s => s.GetProperty("NowPlayingItem").GetProperty("Name").GetString()).ToList();
        }

        public void Dispose()
        {
            SpoilerUserResolver.InvalidateUser(Viewer.Id.ToString("N"));
            Plugin.Dispose();
        }
    }

    [Fact]
    public void AGuardedSeriesKeepsItsUnwatchedEpisodeTitleOutOfTheList()
    {
        using var lab = new Lab();
        lab.GuardShow();
        Assert.Equal(["Pilot", "Season 1, Episode 2"], lab.Names());
        Assert.Equal(["Pilot", "Season 1, Episode 2"], lab.BootstrapNames());
    }

    [Fact]
    public void AnAdministratorWhoGuardsNothingSeesTheListUnchanged()
    {
        using var lab = new Lab();
        Assert.Equal(["Pilot", "The one where the hero dies"], lab.Names());
        Assert.Equal(["Pilot", "The one where the hero dies"], lab.BootstrapNames());
        // Spoiler Guard off for the server: unchanged whatever the user saved.
        lab.GuardShow();
        lab.Config.SpoilerBlurEnabled = false;
        Assert.Equal(["Pilot", "The one where the hero dies"], lab.Names());
    }
}
