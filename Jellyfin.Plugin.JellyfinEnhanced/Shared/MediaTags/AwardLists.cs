using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags
{
    /// <summary>
    /// MDBList award-list ids and list bodies (restructure S2.12: moved verbatim from AwardTagsService). MdblistService
    /// (DetailsProviders), AwardTagsService (MediaTags) and MediaTagsPageFields all read them.
    /// </summary>
    public static class AwardLists
    {
        private static readonly Regex ListId = new(@"^(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_-]{1,80}/[a-zA-Z0-9_-]{1,160})$", RegexOptions.Compiled);

        /// <summary>Accept numeric MDBList ids or a bounded owner/slug; arbitrary URLs are refused.</summary>
        public static bool IsListId(string? id) => id != null && ListId.IsMatch(id);

        /// <summary>MDBList's movies/shows buckets contain TMDB ids and explicit rank, never assume API position is rank.</summary>
        internal static Dictionary<string, int> ParseList(JsonElement root)
        {
            var ranks = new Dictionary<string, int>(StringComparer.Ordinal);
            var valid = false;
            foreach (var (bucket, type) in new[] { ("movies", "movie"), ("shows", "tv") })
            {
                if (!root.TryGetProperty(bucket, out var items) || items.ValueKind != JsonValueKind.Array) continue;
                valid = true;
                foreach (var item in items.EnumerateArray().Take(250))
                {
                    if (!item.TryGetProperty("rank", out var rankValue) || !rankValue.TryGetInt32(out var rank)) continue;
                    // MDBList numbers list positions in steps of 1000 (1000, 2000, ...); fold that back to 1, 2, ...
                    if (rank > 250 && rank % 1000 == 0) rank /= 1000;
                    if (rank is < 1 or > 250) continue;
                    JsonElement id = default;
                    if (item.TryGetProperty("ids", out var ids) && ids.ValueKind == JsonValueKind.Object) ids.TryGetProperty("tmdb", out id);
                    if (id.ValueKind == JsonValueKind.Undefined) item.TryGetProperty("tmdb_id", out id);
                    var text = id.ValueKind is JsonValueKind.String or JsonValueKind.Number ? id.ToString() : "";
                    if (text.Length is > 0 and < 20 && text.All(char.IsAsciiDigit)) ranks[type + ":" + text] = rank;
                }
            }
            if (!valid) throw new JsonException("Missing list buckets");
            // A list that lists titles but yields no usable rank is a parsing problem, never a confirmed empty chart.
            if (ranks.Count == 0 && root.EnumerateObject().Any(b => b.Value.ValueKind == JsonValueKind.Array && b.Value.GetArrayLength() > 0))
                throw new JsonException("List items carry no usable rank");
            return ranks;
        }
    }
}
