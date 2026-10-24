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
        private readonly IEffectiveRequestsBackend _backend;
        private readonly Logger _logger;
        public SeerrIsolationActionFilter(IEffectiveRequestsBackend backend, Logger logger) { _backend = backend; _logger = logger; }
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
            if (context.ActionDescriptor is not ControllerActionDescriptor action || !IsSeerrAction(action))
            {
                await next().ConfigureAwait(false);
                return;
            }
            var captured = _backend.CheckSeerr(SeerrUse.Diagnostics);
            void Deny(string reason)
            {
                _logger.Info("[RequestsBackend] Seerr action denied: " + reason);
                context.HttpContext.Response.Headers["Cache-Control"] = "private, no-store";
                context.Result = new ObjectResult(new { code = reason, error = true }) { StatusCode = 409 };
            }
            if (!captured.Allowed) { Deny(captured.Reason!); return; }
            try
            {
                var executed = await next().ConfigureAwait(false);
                try { _backend.PublishSeerr(captured.Epoch, () => true); }
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
