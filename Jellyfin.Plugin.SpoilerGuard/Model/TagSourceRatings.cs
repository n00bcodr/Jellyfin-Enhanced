using System;
using System.Linq;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.SpoilerGuard.Model
{
    /// <summary>Immutable MDBList ratings in native display units. JSON keys are source ids.</summary>
    public sealed record TagSourceRatings
    {
        [JsonPropertyName("imdb")] public double? Imdb { get; init; }
        [JsonPropertyName("tmdb")] public double? Tmdb { get; init; }
        [JsonPropertyName("rtCritic")] public double? RtCritic { get; init; }
        [JsonPropertyName("rtAudience")] public double? RtAudience { get; init; }
        [JsonPropertyName("metacritic")] public double? Metacritic { get; init; }
        [JsonPropertyName("letterboxd")] public double? Letterboxd { get; init; }
        [JsonPropertyName("trakt")] public double? Trakt { get; init; }

        /// <summary>Use normalized MDBList scores when available; raw values use source-native scales.</summary>
        public static TagSourceRatings? FromMdblist(MdblistCacheEntry? entry)
        {
            if (entry?.Found != true) return null;
            double? Value(string id, double maximum)
            {
                var source = entry.Ratings?.FirstOrDefault(r => r.Source == id);
                var value = source?.Score is { } score ? score * maximum / 100 : source?.Value;
                return value is { } v && double.IsFinite(v) && v >= 0 && v <= maximum ? v : null;
            }
            var result = new TagSourceRatings
            {
                Imdb = Value("imdb", 10), Tmdb = Value("tmdb", 100),
                RtCritic = Value("tomatoes", 100), RtAudience = Value("popcorn", 100),
                Metacritic = Value("metacritic", 100), Letterboxd = Value("letterboxd", 5), Trakt = Value("trakt", 100)
            };
            return result == new TagSourceRatings() ? null : result;
        }

        /// <summary>Look up a configured source id without exposing provider responses.</summary>
        public double? Get(string source) => source switch
        {
            "imdb" => Imdb, "tmdb" => Tmdb, "rtCritic" => RtCritic, "rtAudience" => RtAudience,
            "metacritic" => Metacritic, "letterboxd" => Letterboxd, "trakt" => Trakt, _ => null
        };
    }
}
