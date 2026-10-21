using System;
using System.Net.Http;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Bounded diagnostic codes for a failed provider call (Phase 4c2, review round 7, 4c2-R7-6): what a log line may say
    /// about an upstream failure. Never an exception's message, an answer's body, a request URL or a header: any of those
    /// can carry an API key (TMDB's is in the query, MDBList's too; an upstream or a proxy can echo a header or the URL
    /// back in a body or an error).
    /// </summary>
    internal static class UpstreamDiagnostics
    {
        /// <summary>The code of a failure: its class and, for HTTP, the transport error kind or status.</summary>
        /// <param name="ex">The failure.</param>
        /// <returns>A short code, e.g. <c>timeout</c>, <c>http:ConnectionError</c>, <c>http 503</c>, <c>unreadable</c>.</returns>
        public static string Code(Exception ex) => ex switch
        {
            OperationCanceledException => "timeout",
            HttpRequestException { StatusCode: { } status } => "http " + ((int)status).ToString(System.Globalization.CultureInfo.InvariantCulture),
            HttpRequestException http => "http:" + http.HttpRequestError,
            JsonException => "unreadable",
            _ => ex.GetType().Name,
        };
    }
}
