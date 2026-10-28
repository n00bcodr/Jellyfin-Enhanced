using System;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Outermost owner of <see cref="StageTimings"/> while the admin switch (or <c>JE_STAGE_TIMINGS</c>) is on: one recorder
    /// per request; a <c>Server-Timing</c> header for an administrator's session on Jellyfin Enhanced's own routes and on
    /// any answer that recorded a stage (the absent-title facade), only when the answer is already private or no-store; and
    /// one Debug line per such request naming only the method, route template, status and stage numbers. Off: one
    /// configuration read, and the request is handed on without allocating.
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
        public Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            // Off: hand the request on as it is (no state machine, closure or callback).
            if (!StageTimings.Enabled(JellyfinEnhanced.Instance?.Configuration)) return next();
            return RecordAsync(context, next);
        }

        /// <summary>
        /// Whether no shared cache may keep the answer: <c>no-store</c>, or <c>private</c> for the whole answer. Only such an
        /// answer carries an administrator's timings, so a proxy can never replay them to someone else.
        /// </summary>
        internal static bool Unshared(StringValues cacheControl)
            => CacheControlHeaderValue.TryParse(cacheControl.ToString(), out var value) && value != null
                && (value.NoStore || (value.Private && value.PrivateHeaders.Count == 0 && !value.Public));

        private async Task RecordAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            var http = context.HttpContext;
            var recorder = StageTimings.Begin();
            var own = http.Request.Path.StartsWithSegments("/JellyfinEnhanced", StringComparison.OrdinalIgnoreCase);
            var admin = http.User.IsInRole("Administrator") && !ArrCaller.IsApiKey(http.User);
            var route = context.ActionDescriptor.AttributeRouteInfo?.Template ?? "-";
            var method = http.Request.Method;
            try
            {
                // Registered before every response owner below, so it runs after them (the guard's final check and every
                // owner's Cache-Control included). Never widens what may be cached: a shareable answer gets no header.
                http.Response.OnStarting(() =>
                {
                    if (admin && (own || recorder.Any) && Unshared(http.Response.Headers.CacheControl))
                        http.Response.Headers["Server-Timing"] = recorder.Header();
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
