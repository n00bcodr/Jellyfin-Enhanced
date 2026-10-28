using System;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Outermost owner of <see cref="StageTimings"/> while the admin switch (or <c>JE_STAGE_TIMINGS</c>) is on: one recorder
    /// per request; a <c>Server-Timing</c> header for an administrator's session on Jellyfin Enhanced's own routes and on
    /// any answer that recorded a stage (the absent-title facade); and one Debug line per such request naming only the
    /// method, route template, status and stage numbers. Off: one configuration read and nothing else.
    /// </summary>
    public sealed class StageTimingsFilter : IAsyncResourceFilter, IOrderedFilter
    {
        private readonly Logger? _logger;

        /// <summary>Creates the filter.</summary>
        /// <param name="logger">The plugin log (the Debug line).</param>
        public StageTimingsFilter(Logger? logger = null) => _logger = logger;

        /// <inheritdoc />
        public int Order => int.MinValue;

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            if (!StageTimings.Enabled(JellyfinEnhanced.Instance?.Configuration))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var http = context.HttpContext;
            var recorder = StageTimings.Begin();
            var own = http.Request.Path.StartsWithSegments("/JellyfinEnhanced", StringComparison.OrdinalIgnoreCase);
            var admin = http.User.IsInRole("Administrator") && !ArrCaller.IsApiKey(http.User);
            var route = context.ActionDescriptor.AttributeRouteInfo?.Template ?? "-";
            var method = http.Request.Method;
            try
            {
                // Registered before every response owner below, so it runs after them (the guard's final check included).
                http.Response.OnStarting(() =>
                {
                    if (admin && (own || recorder.Any)) http.Response.Headers["Server-Timing"] = recorder.Header();
                    return Task.CompletedTask;
                });
                http.Response.OnCompleted(() =>
                {
                    if (own || recorder.Any) _logger?.Debug("Stage timings: " + method + " " + route + " " + http.Response.StatusCode + ": " + recorder.Header());
                    recorder.Close();
                    return Task.CompletedTask;
                });
            }
            catch (InvalidOperationException)
            {
                // Already started (an in-process host): nothing to annotate.
            }

            await next().ConfigureAwait(false);
        }
    }
}
