using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Calendar;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.Calendar;

/// <summary>
/// items/by-providers names only items the caller may see: a title held only where the caller has no access
/// is answered exactly as one the server does not hold, as Jellyfin's own item routes do.
/// </summary>
public class ApiItemByProvidersAccessTests
{
    private static readonly Guid Hidden = Guid.NewGuid();
    private static readonly Guid Shown = Guid.NewGuid();

    private static JeCalendarController Calendar(CoreFixture core, User viewer, bool admin)
    {
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer.Id)).Returns(viewer);
        var library = new Mock<ILibraryManager>();
        library.Setup(m => m.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User?>()))
            .Returns((Guid id, User? user) => user?.Id == viewer.Id && id == Shown ? new Movie { Id = id } : null);
        // Tmdb 1 is held only in a library the caller cannot open; Tmdb 2 also has a copy the caller can see.
        var repository = new Mock<IItemRepository>();
        repository.Setup(r => r.GetItemIdsList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.HasAnyProviderId.GetValueOrDefault("Tmdb") switch
            {
                "1" => [Hidden],
                "2" => [Hidden, Shown],
                _ => []
            });
        var controller = (JeCalendarController)ApiAssetTests.Controller(typeof(JeCalendarController), core, users.Object, library.Object, repository.Object);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", viewer.Id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        return controller;
    }

    private static string Lookup(JeCalendarController controller, string tmdbId)
    {
        var result = controller.GetItemIdByProviders(new Dictionary<string, string> { ["Tmdb"] = tmdbId }, "Movie").Result;
        var o = Assert.IsAssignableFrom<ObjectResult>(result);
        return $"{o.StatusCode} {JsonSerializer.Serialize(o.Value)}";
    }

    [Fact]
    public void ATitleTheCallerCannotSeeIsAnsweredAsOneTheServerDoesNotHold()
    {
        using var core = new CoreFixture();
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var controller = Calendar(core, viewer, admin: false);

        var missing = Lookup(controller, "3");
        Assert.StartsWith("400 ", missing);
        Assert.Equal(missing, Lookup(controller, "1"));
        // Where the caller can see one of the matches, that one is named.
        Assert.Equal($"200 \"{Shown}\"", Lookup(controller, "2"));
    }

    [Fact]
    public void AnAdministratorGetsTheSameAnswerAsBefore()
    {
        using var core = new CoreFixture();
        var viewer = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        var controller = Calendar(core, viewer, admin: true);

        Assert.Equal($"200 \"{Hidden}\"", Lookup(controller, "1"));
        Assert.Equal($"200 \"{Hidden}\"", Lookup(controller, "2"));
    }
}
