using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// The item lookups the Seerr discovery pages and the calendar use (studio/, genre/, boxset/,
/// items/by-providers) name an item only when the caller may see it, as Jellyfin decides: a title or box
/// set only within the caller's library access and parental rules (Jellyfin's user item routes), a studio
/// or genre for anyone (Jellyfin's /Studios and /Genres routes). For any other id they answer exactly as
/// for an id that does not exist. Administrators get the same answers as before.
/// </summary>
public class ItemLookupAccessTests
{
    private sealed class Library : IDisposable
    {
        private readonly CoreFixture core = new();
        private readonly Dictionary<Guid, BaseItem> items = new();
        private readonly HashSet<Guid> visible = new();
        public User Viewer { get; } = new("viewer", "default", "default") { Id = Guid.NewGuid() };
        public Mock<ILibraryManager> Manager { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Mock<IItemRepository> Repository { get; } = new();
        public Dictionary<string, Guid[]> ByTmdbId { get; } = new();

        public Library()
        {
            Users.Setup(u => u.GetUserById(Viewer.Id)).Returns(Viewer);
            Manager.Setup(m => m.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => items.GetValueOrDefault(id));
            Manager.Setup(m => m.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => items.GetValueOrDefault(id));
            // Jellyfin's user overload returns null for an item the user may not see (library access, parental rules).
            Manager.Setup(m => m.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User?>()))
                .Returns((Guid id, User? user) => user?.Id == Viewer.Id && visible.Contains(id) ? items.GetValueOrDefault(id) : null);
            Repository.Setup(r => r.GetItemIdsList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                q.HasAnyProviderId?.TryGetValue("Tmdb", out var tmdb) == true && ByTmdbId.TryGetValue(tmdb, out var ids) ? ids.ToList() : new List<Guid>());
        }

        public T Add<T>(T item, bool canSee) where T : BaseItem
        {
            item.Id = Guid.NewGuid();
            items[item.Id] = item;
            if (canSee) visible.Add(item.Id);
            return item;
        }

        public JellyfinEnhancedController Controller(bool admin)
        {
            var controller = ApiAssetTests.Controller(core, Manager.Object, Users.Object, Repository.Object);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", Viewer.Id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public void Dispose() => core.Dispose();
    }

    private static IActionResult Info(JellyfinEnhancedController controller, string route, Guid id) => route switch
    {
        "studio" => controller.GetStudioInfo(id),
        "genre" => controller.GetGenreInfo(id),
        _ => controller.GetBoxSetInfo(id)
    };

    private static string Describe(IActionResult? result) => result is ObjectResult o
        ? $"{o.StatusCode} {JsonSerializer.Serialize(o.Value)}"
        : result?.GetType().Name ?? "null";

    // A hidden box set for boxset/; studio/ and genre/ accept any item id, so a hidden series for them.
    private static BaseItem Hidden(Library library, string route) => route == "boxset"
        ? library.Add(new BoxSet { Name = "Private collection", ProviderIds = new() { ["Tmdb"] = "10" } }, canSee: false)
        : library.Add(new Series { Name = "Private series", ProviderIds = new() { ["Tmdb"] = "11" } }, canSee: false);

    private static BaseItem Shown(Library library, string route) => route == "boxset"
        ? library.Add(new BoxSet { Name = "Open collection" }, canSee: true)
        : library.Add(new Series { Name = "Open series" }, canSee: true);

    [Theory]
    [InlineData("studio")]
    [InlineData("genre")]
    [InlineData("boxset")]
    public void AnItemTheCallerCannotSeeIsAnsweredAsOneThatDoesNotExist(string route)
    {
        using var library = new Library();
        var hidden = Hidden(library, route);
        var shown = Shown(library, route);
        var controller = library.Controller(admin: false);

        var missing = Describe(Info(controller, route, Guid.NewGuid()));
        Assert.StartsWith("404 ", missing);
        Assert.Equal(missing, Describe(Info(controller, route, hidden.Id)));
        // An item the caller may see is still named.
        var answer = Describe(Info(controller, route, shown.Id));
        Assert.StartsWith("200 ", answer);
        Assert.Contains(shown.Name, answer);
    }

    [Theory]
    [InlineData("studio")]
    [InlineData("genre")]
    public void AStudioOrGenreIsNamedForAnySignedInCallerAsJellyfinsOwnRoutesDo(string route)
    {
        using var library = new Library();
        // Jellyfin's user item route hides an untagged studio or genre from a user with an Allowed Tags
        // list; its /Studios/{name} and /Genres/{name} routes still answer them, and so does JE.
        BaseItem entity = route == "studio" ? new Studio { Name = "Open studio" } : new Genre { Name = "Drama" };
        library.Add(entity, canSee: false);
        var controller = library.Controller(admin: false);

        var answer = Describe(Info(controller, route, entity.Id));
        Assert.StartsWith("200 ", answer);
        Assert.Contains(entity.Name, answer);
    }

    [Theory]
    [InlineData("studio")]
    [InlineData("genre")]
    [InlineData("boxset")]
    public void AnAdministratorGetsTheSameAnswerAsBefore(string route)
    {
        using var library = new Library();
        var hidden = Hidden(library, route);
        var controller = library.Controller(admin: true);

        var answer = Describe(Info(controller, route, hidden.Id));
        Assert.StartsWith("200 ", answer);
        Assert.Contains(hidden.Name, answer);
    }

    private static string ByProviders(JellyfinEnhancedController controller, string tmdbId)
        => Describe(controller.GetItemIdByProviders(new Dictionary<string, string> { ["Tmdb"] = tmdbId }, "Movie").Result);

    [Fact]
    public void ByProvidersAnswersATitleTheCallerCannotSeeAsOneTheServerDoesNotHold()
    {
        using var library = new Library();
        var hidden = library.Add(new Movie { Name = "Private film" }, canSee: false);
        var shown = library.Add(new Movie { Name = "Open film" }, canSee: true);
        // Tmdb 1 is held only where the caller has no access; Tmdb 2 also has a copy the caller can see.
        library.ByTmdbId["1"] = [hidden.Id];
        library.ByTmdbId["2"] = [hidden.Id, shown.Id];
        var controller = library.Controller(admin: false);

        var missing = ByProviders(controller, "3");
        Assert.StartsWith("400 ", missing);
        Assert.Equal(missing, ByProviders(controller, "1"));
        // Where the caller can see one of the matches, that one is named.
        Assert.Equal($"200 \"{shown.Id}\"", ByProviders(controller, "2"));
    }

    [Fact]
    public void ByProvidersGivesAnAdministratorTheSameAnswerAsBefore()
    {
        using var library = new Library();
        var hidden = library.Add(new Movie { Name = "Private film" }, canSee: false);
        var shown = library.Add(new Movie { Name = "Open film" }, canSee: true);
        library.ByTmdbId["1"] = [hidden.Id];
        library.ByTmdbId["2"] = [hidden.Id, shown.Id];
        var controller = library.Controller(admin: true);

        Assert.Equal($"200 \"{hidden.Id}\"", ByProviders(controller, "1"));
        Assert.Equal($"200 \"{hidden.Id}\"", ByProviders(controller, "2"));
    }
}
