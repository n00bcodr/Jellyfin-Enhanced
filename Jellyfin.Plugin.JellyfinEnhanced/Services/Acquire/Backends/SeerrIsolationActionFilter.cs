using System;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Routing;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends
{
    /// <summary>Rejects legacy Seerr HTTP entry points before cached links, account import or fallback selection.</summary>
    public sealed class SeerrIsolationActionFilter : IAsyncActionFilter
    {
        private readonly EffectiveRequestsBackend _backend;
        private readonly Logger _logger;
        public SeerrIsolationActionFilter(EffectiveRequestsBackend backend, Logger logger) { _backend = backend; _logger = logger; }
        /// <summary>Uses declared route templates, not a caller-controlled path prefix.</summary>
        internal static bool IsSeerrAction(ControllerActionDescriptor action)
            => action.MethodInfo.GetCustomAttributes(true).OfType<HttpMethodAttribute>().Any(a =>
                a.Template is { } route && (route.StartsWith("jellyseerr/", StringComparison.OrdinalIgnoreCase)
                    || route is "arr/requests" or "arr/requests/{requestId}/approve" or "arr/requests/{requestId}/decline"
                        or "proxy/avatar" or "tmdb/search/person" or "tmdb/search/keyword" or "tmdb/genres/movie" or "tmdb/genres/tv"
                        or "arr/admin/seerr/request-options"
                    || route.StartsWith("acquire/migration/seerr", StringComparison.OrdinalIgnoreCase)));
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // Configuration writers return the configuration they just committed. Their cache invalidation
            // must not enlist the old generation into that acknowledgement; readers still use the scope below.
            if ((context.ActionDescriptor is ControllerActionDescriptor configurationAction
                && configurationAction.MethodInfo.DeclaringType == typeof(Controllers.ConfigurationPatchController)
                && configurationAction.MethodInfo.Name == nameof(Controllers.ConfigurationPatchController.Patch))
                || HostConfigurationRouteFilter.IsJeConfigurationSave(context))
            {
                await next().ConfigureAwait(false);
                return;
            }
            var seerrOnly = context.ActionDescriptor is ControllerActionDescriptor action && IsSeerrAction(action);
            var captured = _backend.CheckSeerr(SeerrUse.Diagnostics);
            void Deny(string reason)
            {
                _logger.Info("[RequestsBackend] Seerr action denied: " + reason);
                context.HttpContext.Response.Headers["Cache-Control"] = "private, no-store";
                context.Result = new ObjectResult(new { code = reason, error = true }) { StatusCode = 409 };
            }
            if (seerrOnly && !captured.Allowed) { Deny(captured.Reason!); return; }
            using var publication = SeerrFacts.BeginPublication();
            try
            {
                var executed = await next().ConfigureAwait(false);
                // A route name cannot certify an acknowledgement: require the actual service's completed
                // durable history result. An uncommitted/synthetic result still takes every old-reader check.
                if (executed.Result is ObjectResult { Value: Requests.SeerrMigrationReply { CommittedHistory: true } }
                    && context.ActionDescriptor is ControllerActionDescriptor migrationAction
                    && migrationAction.MethodInfo.DeclaringType == typeof(Controllers.AcquireMigrationController)
                    && migrationAction.MethodInfo.Name is nameof(Controllers.AcquireMigrationController.Commit)
                        or nameof(Controllers.AcquireMigrationController.Rollback)) return;
                try
                {
                    if (seerrOnly) _backend.Facts.Publish(captured.Epoch, () => true);
                    publication.Publish(() => true);
                }
                catch (BackendDisabledException ex)
                {
                    Deny(ex.Reason);
                    executed.Result = context.Result;
                    executed.ExceptionHandled = true;
                }
            }
            catch (BackendDisabledException ex) { Deny(ex.Reason); }
        }
    }
}
