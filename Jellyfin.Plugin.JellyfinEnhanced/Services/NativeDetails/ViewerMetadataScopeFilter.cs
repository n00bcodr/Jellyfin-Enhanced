using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>Captures the authenticated metadata viewer before controller/filter asynchronous work.</summary>
    public sealed class ViewerMetadataScopeFilter : IAsyncActionFilter
    {
        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (!Guid.TryParse(context.HttpContext.User.FindFirst("Jellyfin-UserId")?.Value, out var viewer) || viewer == Guid.Empty)
            { await next().ConfigureAwait(false); return; }
            using var scope = ViewerMetadataAdmission.ForViewer(viewer);
            await next().ConfigureAwait(false);
        }
    }
}
