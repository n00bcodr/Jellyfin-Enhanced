using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Api.Controllers;

// Stand-ins for Jellyfin's controllers (the unit tests run without Jellyfin.Api; IntegrationJellyfinApiUserActionTests
// reads the real one): the same names, HTTP methods and userId parameters, so the round-9 bracket filter classifies
// their actions as it does Jellyfin's. Their bodies never run: a test's action delegate stands in for them.

/// <summary>Stands in for Jellyfin's user controller.</summary>
public sealed class UserController : ControllerBase
{
    [HttpGet]
    public ActionResult GetUsers() => throw new NotSupportedException();

    [HttpDelete("{userId}")]
    public ActionResult DeleteUser(Guid userId) => throw new NotSupportedException();

    [HttpPost("{userId}/Authenticate")]
    public ActionResult AuthenticateUser(Guid userId, string pw) => throw new NotSupportedException();

    [HttpPost("AuthenticateByName")]
    public ActionResult AuthenticateUserByName(object request) => throw new NotSupportedException();

    [HttpPost("AuthenticateWithQuickConnect")]
    public ActionResult AuthenticateWithQuickConnect(object request) => throw new NotSupportedException();

    [HttpPost("Password")]
    public ActionResult UpdateUserPassword(Guid? userId, object request) => throw new NotSupportedException();

    [HttpPost("{userId}/Password")]
    public ActionResult UpdateUserPasswordLegacy(Guid userId, object request) => throw new NotSupportedException();

    [HttpPost("{userId}/Policy")]
    public ActionResult UpdateUserPolicy(Guid userId, object newPolicy) => throw new NotSupportedException();

    [HttpPost("Configuration")]
    public ActionResult UpdateUserConfiguration(Guid? userId, object userConfig) => throw new NotSupportedException();

    [HttpPost("New")]
    public ActionResult CreateUserByName(object request) => throw new NotSupportedException();
}

/// <summary>Stands in for Jellyfin's Quick Connect controller.</summary>
public sealed class QuickConnectController : ControllerBase
{
    [HttpGet("Enabled")]
    public ActionResult GetQuickConnectEnabled() => throw new NotSupportedException();

    [HttpPost("Authorize")]
    public ActionResult AuthorizeQuickConnect(string code, Guid? userId) => throw new NotSupportedException();
}

/// <summary>Stands in for Jellyfin's start-up wizard controller.</summary>
public sealed class StartupController : ControllerBase
{
    [HttpPost("User")]
    public ActionResult UpdateStartupUser(object startupUserDto) => throw new NotSupportedException();
}

/// <summary>Stands in for a controller that touches no user.</summary>
public sealed class ItemsController : ControllerBase
{
    [HttpPost("{itemId}")]
    public ActionResult UpdateItem(Guid itemId, Guid? userId) => throw new NotSupportedException();
}
