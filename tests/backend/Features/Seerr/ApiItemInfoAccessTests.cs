using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.Seerr;

/// <summary>
/// studio/{id}, genre/{id} and boxset/{id} name a title or box set only when the caller may see it, as
/// Jellyfin's user item routes decide, and a studio or genre for anyone, as its /Studios and /Genres routes
/// do: for any other id they answer exactly as for an id that does not exist.
/// </summary>
public class ApiItemInfoAccessTests
{
    private sealed class Lab : IDisposable
    {
        private readonly CoreFixture core = new();
        private readonly Dictionary<Guid, BaseItem> items = new();
        private readonly HashSet<Guid> visible = new();
        public User Viewer { get; } = new("viewer", "default", "default") { Id = Guid.NewGuid() };
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();

        public Lab()
        {
            Users.Setup(u => u.GetUserById(Viewer.Id)).Returns(Viewer);
            Library.Setup(m => m.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => items.GetValueOrDefault(id));
            Library.Setup(m => m.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => items.GetValueOrDefault(id));
            // Jellyfin's user overload: library access and parental rules for that user.
            Library.Setup(m => m.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User?>()))
                .Returns((Guid id, User? user) => user?.Id == Viewer.Id && visible.Contains(id) ? items.GetValueOrDefault(id) : null);
        }

        public T Add<T>(T item, bool canSee) where T : BaseItem
        {
            item.Id = Guid.NewGuid();
            items[item.Id] = item;
            if (canSee) visible.Add(item.Id);
            return item;
        }

        public JeSeerrController Controller(bool admin)
        {
            var controller = (JeSeerrController)ApiAssetTests.Controller(typeof(JeSeerrController), core, Library.Object, Users.Object);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", Viewer.Id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public void Dispose() => core.Dispose();
    }

    private static IActionResult Call(JeSeerrController controller, string route, Guid id) => route switch
    {
        "studio" => controller.GetStudioInfo(id),
        "genre" => controller.GetGenreInfo(id),
        _ => controller.GetBoxSetInfo(id)
    };

    private static string Describe(IActionResult result) => result is ObjectResult o
        ? $"{o.StatusCode} {JsonSerializer.Serialize(o.Value)}"
        : result.GetType().Name;

    // A hidden box set for boxset/, and for studio/ and genre/ (which accept any item id) a hidden series.
    private static BaseItem Hidden(Lab lab, string route)
        => route == "boxset" ? lab.Add(new BoxSet { Name = "Private collection" }, canSee: false) : lab.Add(new Series { Name = "Private series" }, canSee: false);

    private static BaseItem Shown(Lab lab, string route) => route switch
    {
        "studio" => lab.Add(new Studio { Name = "Open studio" }, canSee: true),
        "genre" => lab.Add(new Genre { Name = "Drama" }, canSee: true),
        _ => lab.Add(new BoxSet { Name = "Open collection" }, canSee: true)
    };

    [Theory]
    [InlineData("studio")]
    [InlineData("genre")]
    [InlineData("boxset")]
    public void AnItemTheCallerCannotSeeIsAnsweredAsOneThatDoesNotExist(string route)
    {
        using var lab = new Lab();
        var hidden = Hidden(lab, route);
        var shown = Shown(lab, route);
        var controller = lab.Controller(admin: false);

        var missing = Describe(Call(controller, route, Guid.NewGuid()));
        Assert.StartsWith("404 ", missing);
        Assert.Equal(missing, Describe(Call(controller, route, hidden.Id)));
        // An item the caller may see is still named.
        Assert.StartsWith("200 ", Describe(Call(controller, route, shown.Id)));
        Assert.Contains(shown.Name, Describe(Call(controller, route, shown.Id)));
    }

    [Theory]
    [InlineData("studio")]
    [InlineData("genre")]
    public void AStudioOrGenreIsNamedForAnySignedInCallerAsJellyfinsOwnRoutesDo(string route)
    {
        using var lab = new Lab();
        // Jellyfin's user item route hides an untagged studio or genre from a user with an Allowed Tags
        // list; its /Studios/{name} and /Genres/{name} routes still answer them, and so does JE.
        BaseItem entity = route == "studio" ? new Studio { Name = "Open studio" } : new Genre { Name = "Drama" };
        lab.Add(entity, canSee: false);
        var controller = lab.Controller(admin: false);

        var answer = Describe(Call(controller, route, entity.Id));
        Assert.StartsWith("200 ", answer);
        Assert.Contains(entity.Name, answer);
    }

    [Theory]
    [InlineData("studio")]
    [InlineData("genre")]
    [InlineData("boxset")]
    public void AnAdministratorGetsTheSameAnswerAsBefore(string route)
    {
        using var lab = new Lab();
        var hidden = Hidden(lab, route);
        var controller = lab.Controller(admin: true);

        var answer = Describe(Call(controller, route, hidden.Id));
        Assert.StartsWith("200 ", answer);
        Assert.Contains(hidden.Name, answer);
    }
}
