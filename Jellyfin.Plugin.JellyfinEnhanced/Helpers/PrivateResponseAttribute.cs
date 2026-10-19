using System;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Marks an administrator's answer as never to be stored by any cache: <c>Cache-Control:
    /// private, no-store</c> on every result of the route (refusals and errors included). Admin arr
    /// answers carry arr URLs, path mappings, root folders, release and client names and who asked
    /// for what. Put on a controller whose routes are all administrators' (or on each admin action
    /// of a mixed one); never on user status or hub routes, which keep <c>private, no-cache</c> with
    /// their ETag. Other headers (ETag, Vary) are left alone.
    /// </summary>
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
    public sealed class PrivateResponseAttribute : Attribute, IAlwaysRunResultFilter
    {
        /// <summary>The header value.</summary>
        public const string CacheControl = "private, no-store";

        /// <inheritdoc />
        public void OnResultExecuting(ResultExecutingContext context)
        {
            context.HttpContext.Response.Headers.CacheControl = CacheControl;
        }

        /// <inheritdoc />
        public void OnResultExecuted(ResultExecutedContext context)
        {
        }
    }
}
