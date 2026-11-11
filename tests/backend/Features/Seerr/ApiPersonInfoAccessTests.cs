using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.Seerr;

/// <summary>
/// person/{id} names an item only when the caller may see it, like studio/, genre/ and boxset/: for any
/// other id it answers exactly as for an id that does not exist, as Jellyfin's own item routes do.
/// </summary>
public class ApiPersonInfoAccessTests
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

    private static async Task<string> Describe(Task<IActionResult> call) => await call is ObjectResult o
        ? $"{o.StatusCode} {JsonSerializer.Serialize(o.Value)}"
        : "other";

    [Fact]
    public async Task AnItemTheCallerCannotSeeIsAnsweredAsOneThatDoesNotExist()
    {
        using var lab = new Lab();
        var hidden = lab.Add(new Movie { Name = "Private film", PremiereDate = new DateTime(2020, 5, 1) }, canSee: false);
        var person = lab.Add(new Person { Name = "Open actor" }, canSee: true);
        var controller = lab.Controller(admin: false);

        var missing = await Describe(controller.GetPersonInfo(Guid.NewGuid()));
        Assert.StartsWith("404 ", missing);
        Assert.Equal(missing, await Describe(controller.GetPersonInfo(hidden.Id)));
        // A person the caller may see is still named.
        var shown = await Describe(controller.GetPersonInfo(person.Id));
        Assert.StartsWith("200 ", shown);
        Assert.Contains(person.Name, shown);
    }

    [Fact]
    public async Task AnAdministratorGetsTheSameAnswerAsBefore()
    {
        using var lab = new Lab();
        var hidden = lab.Add(new Movie { Name = "Private film" }, canSee: false);
        var controller = lab.Controller(admin: true);

        var answer = await Describe(controller.GetPersonInfo(hidden.Id));
        Assert.StartsWith("200 ", answer);
        Assert.Contains(hidden.Name, answer);
    }
}
