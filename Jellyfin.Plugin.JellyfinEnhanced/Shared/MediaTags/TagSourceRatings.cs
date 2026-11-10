using System;
using System.Linq;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Mdblist;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags
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
        [JsonPropertyName("myAnimeList")] public double? MyAnimeList { get; init; }
        [JsonPropertyName("aniList")] public double? AniList { get; init; }
        [JsonPropertyName("metacriticUser")] public double? MetacriticUser { get; init; }
        [JsonPropertyName("rogerEbert")] public double? RogerEbert { get; init; }
        [JsonPropertyName("mdblist")] public double? Mdblist { get; init; }

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
                Metacritic = Value("metacritic", 100), Letterboxd = Value("letterboxd", 5), Trakt = Value("trakt", 100),
                MyAnimeList = Value("myanimelist", 10), AniList = Value("anilist", 100),
                MetacriticUser = Value("metacriticuser", 10), RogerEbert = Value("rogerebert", 4), Mdblist = Value("master", 100)
            };
            return result == new TagSourceRatings() ? null : result;
        }

        /// <summary>Look up a configured source id without exposing provider responses.</summary>
        public double? Get(string source) => source switch
        {
            "imdb" => Imdb, "tmdb" => Tmdb, "rtCritic" => RtCritic, "rtAudience" => RtAudience,
            "metacritic" => Metacritic, "letterboxd" => Letterboxd, "trakt" => Trakt,
            "myAnimeList" => MyAnimeList, "aniList" => AniList, "metacriticUser" => MetacriticUser,
            "rogerEbert" => RogerEbert, "mdblist" => Mdblist, _ => null
        };
    }
}
