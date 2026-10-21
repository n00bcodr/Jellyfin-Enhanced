using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Names the server's JE build (the client script's cache key, which changes with every build) on every answer of JE's own
    /// routes (header <see cref="HeaderName"/>; the bootstrap also carries it in its body). A page compares it with the build
    /// it loaded and, when they differ, asks the person to reload before a save can be lost to a contract the page doesn't
    /// know (js/core/api-client.js).
    /// </summary>
    public sealed class ClientBuildFilter : IAlwaysRunResultFilter
    {
        /// <summary>The header naming the server's JE build.</summary>
        public const string HeaderName = "X-JE-Build";

        /// <inheritdoc />
        public void OnResultExecuting(ResultExecutingContext context)
        {
            if (context.Controller?.GetType().Assembly != typeof(JellyfinEnhanced).Assembly) return;
            var build = JellyfinEnhanced.Instance?.ScriptCacheKey;
            if (!string.IsNullOrEmpty(build)) context.HttpContext.Response.Headers[HeaderName] = build;
        }

        /// <inheritdoc />
        public void OnResultExecuted(ResultExecutedContext context)
        {
        }
    }
}
