using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Answers a body over the action's <see cref="RequestSizeLimitAttribute"/> with a 413 JSON
    /// response. Kestrel throws <see cref="BadHttpRequestException"/> while model binding reads the
    /// body; without this filter Jellyfin's ExceptionMiddleware turns it into a 500 and logs an error
    /// for every oversized request, including ones from callers the action would reject anyway.
    /// </summary>
    public sealed class RejectOversizedBodyAttribute : ExceptionFilterAttribute
    {
        /// <inheritdoc />
        public override void OnException(ExceptionContext context)
        {
            if (context.Exception is BadHttpRequestException { StatusCode: StatusCodes.Status413PayloadTooLarge })
            {
                context.Result = new ObjectResult(new { success = false, message = "Request body too large." })
                {
                    StatusCode = StatusCodes.Status413PayloadTooLarge,
                };
                context.ExceptionHandled = true;
            }
        }
    }
}
