using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// When a provider's answer PROVES that something doesn't exist (review round 10, D53 "absence is a positive fact"): an
    /// absence ("not found", "no such id", a confirmed miss) only from the provider's documented affirmative signal, its
    /// status AND its body shape; every other answer (an error, a 5xx, a proxy's page, empty or malformed data, GraphQL errors
    /// of another kind) is a failure (upstream_error / transient), never an absence. The one owner of these decisions:
    /// <list type="bullet">
    /// <item><b>TMDB</b> (list sources, import lookups, posters): 404 with TMDB's error object, <c>status_code</c> 34 ("The
    /// resource you requested could not be found") or 6 ("Invalid id"), as TMDB answers a missing list, collection, title or
    /// season (seen live 2026-10-20).</item>
    /// <item><b>Seerr</b>: none. Seerr answers a missing title, season or collection with 500 ("Unable to retrieve …", seen live
    /// on Seerr 3.3.0); its 404 is its unknown-route answer (<c>{"message":"not found","errors":[]}</c>: a wrong address or a
    /// proxy), so no Seerr answer is an absence.</item>
    /// <item><b>IMDb</b> (GraphQL): the queried root is null AND an error on that root's path says <c>RESOURCE_NOT_FOUND</c>,
    /// <c>NOT_FOUND</c> or <c>FORBIDDEN</c> (a missing list; a private watchlist). <c>INTERNAL_SERVER_ERROR</c> (IMDb's answer to a
    /// missing profile, seen live), <c>SERVICE_UNAVAILABLE_ERROR</c>, empty or missing data are failures.</item>
    /// <item><b>MDBList API lists</b>: 404, or 403 ("Permission denied": private), with MDBList's error object
    /// (<c>{"error": "…"}</c>, its API blueprint); a 401 is a refused key, never an absence.</item>
    /// <item><b>MDBList ratings</b>: <c>{"response": false, "error": "…"}</c>, MDBList's "no match" answer; a batch's omitted id
    /// only when the batch is admitted whole (MdblistService).</item>
    /// <item><b>MDBList public JSON, Trakt, Chronolists</b>: the site's own status (no proxy in between: the source transport
    /// follows no redirects): MDBList 401/403/404 (not public), Trakt 404 ("no record found"), Chronolists 404 or a page of
    /// another route (Next's <c>page</c> isn't <c>/[universe]</c>).</item>
    /// <item><b>Searches and seasons</b>: an empty page is "no titles" only when its contract is Valid: the page asked for,
    /// bound, with a total of 0 (ResponseContract's paging rules); a season's episode list is the season's own listing.</item>
    /// </list>
    /// </summary>
    internal static class ProviderAbsence
    {
        private static readonly HashSet<string> ImdbAbsentCodes = new(StringComparer.Ordinal) { "RESOURCE_NOT_FOUND", "NOT_FOUND", "FORBIDDEN" };

        /// <summary>TMDB says the resource doesn't exist: 404 with its error object (<c>status_code</c> 34 or 6).</summary>
        /// <param name="status">HTTP status.</param>
        /// <param name="body">The answer's body (null: not read).</param>
        /// <returns>Whether it is TMDB's affirmative "not found".</returns>
        public static bool Tmdb(int status, string? body)
        {
            if (status != 404 || string.IsNullOrEmpty(body))
            {
                return false;
            }

            try
            {
                using var doc = JsonDocument.Parse(body);
                return doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("status_code", out var code) && code.ValueKind == JsonValueKind.Number
                    && code.TryGetInt32(out var number) && number is 34 or 6;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        /// <summary>No Seerr answer is an absence (Seerr's missing resources are 500; its 404 is an unknown route).</summary>
        /// <param name="status">HTTP status.</param>
        /// <returns>False.</returns>
        public static bool Seerr(int status) => false;

        /// <summary>
        /// IMDb says the queried resource doesn't exist or isn't readable: <paramref name="root"/> is null in <c>data</c> (or
        /// <c>data</c> is null) and an error on that root's path carries an affirmative code.
        /// </summary>
        /// <param name="answer">The GraphQL answer (with <c>data</c> and <c>errors</c>).</param>
        /// <param name="root">The queried root field (<c>list</c>, <c>predefinedList</c>, <c>chartTitles</c>, <c>userProfile</c>).</param>
        /// <returns>Whether it is IMDb's affirmative absence.</returns>
        public static bool Imdb(JsonElement answer, string root)
        {
            if (answer.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var data = answer.TryGetProperty("data", out var d) ? d : default;
            var rootNull = data.ValueKind == JsonValueKind.Null
                || (data.ValueKind == JsonValueKind.Object && data.TryGetProperty(root, out var value) && value.ValueKind == JsonValueKind.Null);
            if (!rootNull || !answer.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            return errors.EnumerateArray().Any(error => error.ValueKind == JsonValueKind.Object
                && error.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.Array && path.GetArrayLength() > 0
                && path[0].ValueKind == JsonValueKind.String && string.Equals(path[0].GetString(), root, StringComparison.Ordinal)
                && error.TryGetProperty("extensions", out var extensions) && extensions.ValueKind == JsonValueKind.Object
                && extensions.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String && ImdbAbsentCodes.Contains(code.GetString()!));
        }

        /// <summary>MDBList's API says the list doesn't exist or is private: 404 or 403 with its error object.</summary>
        /// <param name="status">HTTP status.</param>
        /// <param name="body">The body.</param>
        /// <returns>Whether it is MDBList's affirmative absence.</returns>
        public static bool MdblistApi(int status, string? body) => status is 404 or 403 && ErrorObject(body);

        /// <summary>MDBList's ratings "no match": <c>{"response": false, "error": "…"}</c>.</summary>
        /// <param name="answer">The answer.</param>
        /// <returns>Whether it is MDBList's affirmative miss.</returns>
        public static bool MdblistRatings(JsonElement answer) => answer.ValueKind == JsonValueKind.Object
            && answer.TryGetProperty("response", out var response) && response.ValueKind == JsonValueKind.False
            && answer.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String;

        // A JSON object with a string `error` (MDBList's error object).
        private static bool ErrorObject(string? body)
        {
            if (string.IsNullOrEmpty(body))
            {
                return false;
            }

            try
            {
                using var doc = JsonDocument.Parse(body);
                return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String;
            }
            catch (JsonException)
            {
                return false;
            }
        }
    }
}
