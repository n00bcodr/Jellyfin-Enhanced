using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// <c>items/by-providers</c>: an item the caller can open, nothing (204) when the library has none, 400 only
/// when no provider id is given. The calendar asks it for every title it shows; a title not in the library
/// is its everyday case, not an error.
/// </summary>
[Collection("Plugin singleton")]
public class ApiItemsByProvidersTests
{
    [Fact]
    public void ATitleTheLibraryDoesntHaveIsAnEmptyAnswerNotABadRequest()
    {
        using var plugin = new ApiPluginFixture();
        var user = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Guid.NewGuid() };
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() };
        var repository = new Mock<IItemRepository>();
        repository.Setup(r => r.GetItemIdsList(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery q) => q.HasAnyProviderId!.TryGetValue("Tmdb", out var id) && id == "603" ? new List<Guid> { movie.Id } : new List<Guid>());
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        var controller = ApiAssetTests.Controller(plugin.Core, users.Object, repository.Object, library.Object);
        controller.ControllerContext.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.Id.ToString())], "test"));

        Assert.IsType<NoContentResult>(controller.GetItemIdByProviders(new Dictionary<string, string> { ["Tmdb"] = "284833" }, "Series").Result);
        Assert.IsType<BadRequestObjectResult>(controller.GetItemIdByProviders(new Dictionary<string, string>(), null).Result);
        Assert.IsType<BadRequestObjectResult>(controller.GetItemIdByProviders(null, null).Result);
    }
}
