using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

/// <summary>
/// Callers as Jellyfin's authentication handler builds them, with a user manager that knows the
/// people among them: a member, an administrator, a 12.2-style API key (the empty user id, the
/// administrator role claim and <c>Jellyfin-IsApiKey</c>), and a signed-in user Jellyfin doesn't
/// know (deleted since). Like Jellyfin 12, the user manager throws for the empty GUID.
/// </summary>
internal sealed class TestCallers
{
    public Mock<IUserManager> Users { get; } = new();

    public TestCallers()
    {
        Users.Setup(m => m.GetUserById(Guid.Empty)).Throws(new ArgumentException("Guid can't be empty", "id"));
    }

    /// <summary>Registers (or updates) a Jellyfin user with this id and role and returns its principal.</summary>
    public ClaimsPrincipal Person(bool admin, Guid? id = null)
    {
        var user = Register(id ?? Guid.NewGuid(), admin);
        return Principal(user.Id, admin);
    }

    /// <summary>Registers a Jellyfin user.</summary>
    public User Register(Guid id, bool admin, string? name = null)
    {
        var user = new User(name ?? "user-" + id.ToString("N")[..6], "default", "default") { Id = id };
        user.SetPermission(PermissionKind.IsAdministrator, admin);
        Users.Setup(m => m.GetUserById(id)).Returns(user);
        return user;
    }

    /// <summary>A principal for a user id (registered or not) with the role claim Jellyfin gives it.</summary>
    public static ClaimsPrincipal Principal(Guid id, bool admin)
        => new(new ClaimsIdentity([new Claim("Jellyfin-UserId", id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));

    /// <summary>An API key as Jellyfin 12.2 authenticates it.</summary>
    public static ClaimsPrincipal ApiKey()
        => new(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", Guid.Empty.ToString()), new Claim(ClaimTypes.Role, "Administrator"),
            new Claim("Jellyfin-IsApiKey", "True"), new Claim("Jellyfin-Token", "0123456789abcdef0123456789abcdef")], "test"));

    /// <summary>A signed-in user Jellyfin doesn't know any more, with the administrator role claim (the worst case).</summary>
    public static ClaimsPrincipal Unknown() => Principal(Guid.NewGuid(), admin: true);
}
