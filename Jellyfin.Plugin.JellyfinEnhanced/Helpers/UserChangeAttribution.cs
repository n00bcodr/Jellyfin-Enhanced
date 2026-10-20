using System;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Tells JE's user caches whom a Jellyfin user action whose person isn't known before it runs turned out to be about
    /// (<see cref="UserAuthority.Finished"/>). Those actions are the ones <see cref="JellyfinUserChangeBracket"/> brackets
    /// for every person (the same classification, <see cref="JellyfinUserActions.KeyOf"/>): a sign-in by name or with Quick
    /// Connect, a new user, the start-up wizard. When one has run, its person is the user it signed in or created (the
    /// answer's user), or for a failed sign-in by name the user of that name, the only one Jellyfin's sign-in touches (a
    /// failed attempt's count; a lockout is also announced; none when there is no such user). Then only that person's
    /// cached entries are read again; when the person can't be told, every cached user is.
    /// <para>
    /// Before the response leaves the server, so the next request a client makes after it sees the change. A request
    /// running alongside the action may still be answered from what was cached before it, as it would had it come a
    /// moment sooner.
    /// </para>
    /// </summary>
    public sealed class UserChangeAttribution : IAsyncActionFilter
    {
        private readonly IUserManager _users;

        /// <summary>Creates the filter (DI).</summary>
        /// <param name="users">Jellyfin's user manager (a failed sign-in's user is looked up by name).</param>
        public UserChangeAttribution(IUserManager users)
        {
            _users = users;
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (context.ActionDescriptor is not ControllerActionDescriptor { MethodInfo: { } method } action
                || !UnknownPerson(context, JellyfinUserActions.KeyOf(method, action.ControllerTypeInfo.Name, context.HttpContext.Request.Method)))
            {
                await next().ConfigureAwait(false);
                return;
            }

            Guid? person = null;
            try
            {
                var executed = await next().ConfigureAwait(false);
                person = PersonOf(executed, context);
            }
            finally
            {
                UserAuthority.Finished(person);
            }
        }

        // The bracket's own rule: every person's when the action's person isn't known before it runs.
        private static bool UnknownPerson(ActionExecutingContext context, JellyfinUserKey key) => key switch
        {
            JellyfinUserKey.None => false,
            JellyfinUserKey.User => KnownPerson(context) == null,
            _ => true,
        };

        private static Guid? KnownPerson(ActionExecutingContext context)
        {
            if (context.ActionArguments.TryGetValue("userId", out var id) && id is Guid user && user != Guid.Empty) return user;
            return Guid.TryParse(context.HttpContext.User?.FindFirst(JellyfinUserChangeBracket.UserIdClaim)?.Value, out var principal) && principal != Guid.Empty ? principal : null;
        }

        // The user the answer carries (a sign-in's AuthenticationResult.User, a new user's UserDto). For a sign-in by name
        // that didn't succeed (Jellyfin throws), the user of that name (Guid.Empty when there is none: nobody was touched).
        // Null when it can't be told.
        private Guid? PersonOf(ActionExecutedContext executed, ActionExecutingContext context)
        {
            if (executed.Exception == null && (executed.Result as ObjectResult)?.Value is { } value)
            {
                var user = value.GetType().GetProperty("User")?.GetValue(value) ?? value;
                return user.GetType().Name == "UserDto" && user.GetType().GetProperty("Id")?.GetValue(user) is Guid id && id != Guid.Empty ? id : null;
            }

            if (context.ActionDescriptor is ControllerActionDescriptor { ActionName: "AuthenticateUserByName" })
            {
                foreach (var argument in context.ActionArguments.Values)
                {
                    if (argument?.GetType().GetProperty("Username")?.GetValue(argument) is string name && name.Length > 0)
                    {
                        return _users.GetUserByName(name)?.Id ?? Guid.Empty;
                    }
                }
            }

            return null;
        }
    }
}
