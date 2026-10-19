using System;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>Shapes model-binding and body-limit refusals with the same contract as request actions.</summary>
    [AttributeUsage(AttributeTargets.Class)]
    public sealed class RequestOutcomeFilterAttribute : Attribute, IAlwaysRunResultFilter, IExceptionFilter
    {
        /// <inheritdoc />
        public void OnResultExecuting(ResultExecutingContext context)
        {
            if (context.Result is ObjectResult { StatusCode: >= 400 } result && result.Value is not RequestOutcome)
            {
                var status = result.StatusCode!.Value;
                result.Value = RequestOutcome.Refused(status == 413 ? "payload_too_large" : "invalid_input", status);
                context.HttpContext.Response.Headers["Cache-Control"] = "private, no-store";
            }
        }
        /// <inheritdoc />
        public void OnException(ExceptionContext context)
        {
            context.Result = new ObjectResult(RequestOutcome.Refused("request_unavailable", 503, "unavailable")) { StatusCode = 503 };
            context.HttpContext.Response.Headers["Cache-Control"] = "private, no-store";
            context.ExceptionHandled = true;
        }
        /// <inheritdoc />
        public void OnResultExecuted(ResultExecutedContext context) { }
    }
}
