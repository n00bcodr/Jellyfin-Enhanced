using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Users;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers;

/// <summary>Human-administrator settings on Jellyfin's own Users pages. Personal consent and email verification are read-only.</summary>
[ApiController]
[AdminUserSettingsErrors]
[Authorize]
[PrivateResponse]
[Route("JellyfinEnhanced")]
public sealed class AcquireAdminUsersController : ControllerBase
{
    private readonly AdminUserSettingsService _service;
    private readonly IUserManager _users;
    /// <summary>Creates the controller.</summary>
    public AcquireAdminUsersController(AdminUserSettingsService service,IUserManager users) { _service=service;_users=users; }
    private IActionResult Reply(AdminUserResult result) {Response.Headers["Cache-Control"]="private, no-store";return StatusCode(result.Status,JsonSerializer.SerializeToElement(result.Body,new JsonSerializerOptions(JsonSerializerDefaults.Web)));}
    private IActionResult Run(Func<Guid,AdminUserResult> action)
    {
        var person=ArrCaller.Human(User,_users);
        if(person==null) return Reply(new(403,new{reason="user_required"}));
        if(!ArrCaller.IsAdmin(User,_users)) return Reply(new(403,new{reason="admin_required"}));
        return Reply(action(person.Id));
    }
    private IActionResult Edit(string userId,string group,JsonElement body) => Run(actor=>Guid.TryParse(userId,out var id)&&id!=Guid.Empty?_service.Patch(actor,id,group,body):new(400,new{reason="invalid_user"}));
    /// <summary>One bounded batch of card summaries, including disabled users.</summary>
    [Authorize]
    [HttpGet("arr/admin/users/summary")]
    public IActionResult Summary([FromQuery]int offset=0,[FromQuery]int limit=500) => Run(_=>_service.Summary(offset,limit));
    /// <summary>Independent stored and effective components for one person; reads never seed or import.</summary>
    [Authorize]
    [HttpGet("arr/admin/users/{userId}")]
    public async Task<IActionResult> GetUser(string userId, CancellationToken ct = default)
    {
        if (!ArrCaller.IsAdmin(User, _users)) return Run(_ => new(403, new { reason = "admin_required" }));
        if (!Guid.TryParse(userId, out var id) || id == Guid.Empty) return Reply(new(400, new { reason = "invalid_user" }));
        var result = await _service.ReadAsync(id, ct).ConfigureAwait(false);
        return Run(_ => result);
    }
    /// <summary>Role, count/GB overrides and 4K grants. Omitted fields keep their stored value; null inherits.</summary>
    [Authorize]
    [HttpPatch("arr/admin/users/{userId}/policy")]
    [BodyLimit(16384)]
    public IActionResult Policy(string userId,[FromBody]JsonElement body) => Edit(userId,"policy",body);
    /// <summary>Only this person's explicit pool membership; pool order, definitions and historical spend stay in place.</summary>
    [Authorize]
    [HttpPatch("arr/admin/users/{userId}/pool-membership")]
    [BodyLimit(16384)]
    public IActionResult PoolMembership(string userId,[FromBody]JsonElement body) => Edit(userId,"pool-membership",body);
    /// <summary>D29 display allowlist; no consent or verified-email field can be written here.</summary>
    [Authorize]
    [HttpPatch("arr/admin/users/{userId}/display")]
    [BodyLimit(16384)]
    public IActionResult Display(string userId,[FromBody]JsonElement body) => Edit(userId,"display",body);
    /// <summary>Only the Seerr import exclusion; never imports a person as a side effect.</summary>
    [Authorize]
    [HttpPatch("arr/admin/users/{userId}/seerr-import")]
    [BodyLimit(16384)]
    public IActionResult SeerrImport(string userId,[FromBody]JsonElement body) => Edit(userId,"seerr-import",body);
}

/// <summary>Sanitizes unexpected failures while preserving the administrator API's explicit domain error codes.</summary>
internal sealed class AdminUserSettingsErrorsAttribute : Attribute, Microsoft.AspNetCore.Mvc.Filters.IExceptionFilter
{
    public void OnException(Microsoft.AspNetCore.Mvc.Filters.ExceptionContext context)
    {
        context.Result = new ObjectResult(new { reason = "settings_unavailable" }) { StatusCode = 503 };
        context.HttpContext.Response.Headers["Cache-Control"] = "private, no-store";
        context.ExceptionHandled = true;
    }
}
