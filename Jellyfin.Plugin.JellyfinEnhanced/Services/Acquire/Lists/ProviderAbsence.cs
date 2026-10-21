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
    /// <item><b>IMDb</b> (GraphQL; review round 11, 4c2-R11-1: absence targets the queried root exactly): the queried root is
    /// null in an object <c>data</c>, the envelope is well formed (<see cref="ImdbEnvelope"/>), EVERY error carries
    /// <c>RESOURCE_NOT_FOUND</c>, <c>NOT_FOUND</c> or <c>FORBIDDEN</c> on the root itself or one of its own fields, and one of
    /// them is on the root or its identity (<c>id</c>): IMDb answers a missing list with errors on <c>["list","id"]</c>,
    /// <c>["list","name"]</c> and <c>["list","items"]</c> (never on <c>["list"]</c>), a private watchlist with FORBIDDEN on
    /// <c>["predefinedList"]</c> (both seen live 2026-10-21). An error under the root's connection (a title of the list:
    /// <c>["list","items","edges",0,"node","item"]</c>), a null propagated from a field that isn't the root's identity, another
    /// code next to it (<c>INTERNAL_SERVER_ERROR</c>, IMDb's answer to a missing profile; <c>SERVICE_UNAVAILABLE_ERROR</c>),
    /// <c>data</c> null or without the root are failures.</item>
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

        /// <summary>IMDb says the queried resource doesn't exist or isn't readable (<see cref="ImdbEnvelope"/> is <see cref="GraphQlVerdict.Absent"/>).</summary>
        /// <param name="answer">The GraphQL answer (with <c>data</c> and <c>errors</c>).</param>
        /// <param name="root">The queried root field (<c>list</c>, <c>predefinedList</c>, <c>chartTitles</c>, <c>userProfile</c>).</param>
        /// <returns>Whether it is IMDb's affirmative absence.</returns>
        public static bool Imdb(JsonElement answer, string root) => ImdbEnvelope(answer, root) == GraphQlVerdict.Absent;

        /// <summary>
        /// The verdict of one IMDb GraphQL answer for its queried root (review round 11, 4c2-R11-1/2: one reader of the envelope,
        /// whose verdict every step of a read reports, so a read made of several queries carries every step's):
        /// <list type="bullet">
        /// <item><see cref="GraphQlVerdict.Malformed"/>: not an object; <c>errors</c> present but not an array (an object,
        /// <c>null</c>), or an error that isn't an object, or whose <c>path</c> isn't an array of names and indexes, or whose
        /// <c>extensions</c> isn't an object; <c>data</c> missing, not an object, or without the root.</item>
        /// <item><see cref="GraphQlVerdict.Absent"/>: the root null and IMDb's affirmative absence (the class summary).</item>
        /// <item><see cref="GraphQlVerdict.Failed"/>: the root null otherwise (an error answer: never "not found").</item>
        /// <item><see cref="GraphQlVerdict.Partial"/>: the root answered with errors next to it (nulled items may be missing).</item>
        /// <item><see cref="GraphQlVerdict.Clean"/>: the root answered, no error.</item>
        /// </list>
        /// </summary>
        /// <param name="answer">The GraphQL answer.</param>
        /// <param name="root">The queried root field.</param>
        /// <returns>The verdict.</returns>
        public static GraphQlVerdict ImdbEnvelope(JsonElement answer, string root)
        {
            if (answer.ValueKind != JsonValueKind.Object)
            {
                return GraphQlVerdict.Malformed;
            }

            var errors = new List<JsonElement>();
            if (answer.TryGetProperty("errors", out var list))
            {
                if (list.ValueKind != JsonValueKind.Array)
                {
                    return GraphQlVerdict.Malformed;
                }

                foreach (var error in list.EnumerateArray())
                {
                    if (error.ValueKind != JsonValueKind.Object
                        || (error.TryGetProperty("path", out var path) && (path.ValueKind != JsonValueKind.Array || path.EnumerateArray().Any(step => step.ValueKind is not (JsonValueKind.String or JsonValueKind.Number))))
                        || (error.TryGetProperty("extensions", out var extensions) && extensions.ValueKind != JsonValueKind.Object))
                    {
                        return GraphQlVerdict.Malformed;
                    }

                    errors.Add(error);
                }
            }

            if (!answer.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object || !data.TryGetProperty(root, out var value))
            {
                return GraphQlVerdict.Malformed;
            }

            if (value.ValueKind != JsonValueKind.Null)
            {
                return errors.Count == 0 ? GraphQlVerdict.Clean : GraphQlVerdict.Partial;
            }

            // The root is null: an absence only when every error is IMDb's affirmative one on the root itself or a field of it,
            // and one is on the root or its identity (a list's `id`); anything deeper, or of another code, is an error answer.
            var absent = errors.Count > 0
                && errors.All(error => ImdbAbsentCode(error) && PathOf(error) is { } path && path[0] == root && path.Count <= 2)
                && errors.Any(error => PathOf(error) is { } path && (path.Count == 1 || path[1] == "id"));
            return absent ? GraphQlVerdict.Absent : GraphQlVerdict.Failed;
        }

        // An error's path as names (an index as its digits), or null without one.
        private static List<string>? PathOf(JsonElement error) =>
            error.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.Array && path.GetArrayLength() > 0
                ? path.EnumerateArray().Select(step => step.ValueKind == JsonValueKind.String ? step.GetString()! : step.GetRawText()).ToList()
                : null;

        private static bool ImdbAbsentCode(JsonElement error) =>
            error.TryGetProperty("extensions", out var extensions) && extensions.ValueKind == JsonValueKind.Object
            && extensions.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String && ImdbAbsentCodes.Contains(code.GetString()!);

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

    /// <summary>The verdict of one GraphQL answer for its queried root (<see cref="ProviderAbsence.ImdbEnvelope"/>).</summary>
    internal enum GraphQlVerdict
    {
        /// <summary>The root answered, no error.</summary>
        Clean,

        /// <summary>The root answered with errors next to it: rows may be missing (never complete).</summary>
        Partial,

        /// <summary>The provider's affirmative absence of the queried resource.</summary>
        Absent,

        /// <summary>The root is null without an affirmative absence: an error answer.</summary>
        Failed,

        /// <summary>An envelope JE can't read (errors that aren't a list of error objects, data without the root).</summary>
        Malformed,
    }
}
