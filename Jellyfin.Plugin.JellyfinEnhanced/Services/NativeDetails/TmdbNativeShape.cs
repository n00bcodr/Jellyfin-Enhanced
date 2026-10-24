using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// TMDB's own answers (snake_case) in the shape Seerr gives the same data (camelCase), so the native
    /// details facade, its feeds and the page's extras read one shape whichever source answered
    /// (Requests &amp; downloads, A1: Jellyfin Enhanced mode reads TMDB, never Seerr). Only public TMDB
    /// fields are carried; Seerr's own parts (mediaInfo, requests, Seerr ratings) have no TMDB
    /// counterpart and are left out. A field TMDB doesn't give is left out too, never made up: every
    /// reader of the shape already treats a missing field as unknown.
    /// </summary>
    internal static class TmdbNativeShape
    {
        /// <summary>The sub-resources a movie's details are read with (one TMDB call).</summary>
        internal const string MovieAppend = "credits,release_dates,external_ids,videos,keywords,watch/providers";

        /// <summary>The sub-resources a series' details are read with (one TMDB call).</summary>
        internal const string SeriesAppend = "credits,content_ratings,external_ids,videos,keywords,watch/providers";

        /// <summary>Seerr's movie details shape of a TMDB movie read with <see cref="MovieAppend"/>.</summary>
        /// <param name="m">TMDB's movie.</param>
        /// <param name="imdb">The IMDb id the library or an arr knows the movie by, used when TMDB has none.</param>
        /// <returns>The details.</returns>
        internal static JsonObject Movie(JsonElement m, string? imdb = null)
        {
            var o = new JsonObject();
            Copy(o, m, "id", "id");
            Copy(o, m, "title", "title");
            Copy(o, m, "original_title", "originalTitle");
            Copy(o, m, "overview", "overview");
            Copy(o, m, "tagline", "tagline");
            Copy(o, m, "release_date", "releaseDate");
            Copy(o, m, "runtime", "runtime");
            Copy(o, m, "status", "status");
            Copy(o, m, "budget", "budget");
            Copy(o, m, "revenue", "revenue");
            Copy(o, m, "homepage", "homepage");
            Copy(o, m, "original_language", "originalLanguage");
            Copy(o, m, "adult", "adult");
            Copy(o, m, "video", "video");
            Copy(o, m, "popularity", "popularity");
            Copy(o, m, "vote_average", "voteAverage");
            Copy(o, m, "vote_count", "voteCount");
            Copy(o, m, "poster_path", "posterPath");
            Copy(o, m, "backdrop_path", "backdropPath");
            Named(o, m, "genres", "genres");
            Companies(o, m, "production_companies", "productionCompanies");
            Raw(o, m, "production_countries", "productionCountries");
            Languages(o, m);
            var external = Obj(m, "external_ids");
            var ownImdb = Str(m, "imdb_id") ?? Str(external, "imdb_id") ?? imdb;
            if (!string.IsNullOrEmpty(ownImdb)) o["imdbId"] = ownImdb;
            o["externalIds"] = ExternalIds(external, ownImdb, null);
            // Seerr keeps TMDB's release dates as they are (certifications per region).
            Raw(o, m, "release_dates", "releases");
            o["credits"] = Credits(Obj(m, "credits"));
            if (Obj(m, "belongs_to_collection") is { ValueKind: JsonValueKind.Object } collection && Int(collection, "id") is > 0)
            {
                var c = new JsonObject();
                Copy(c, collection, "id", "id");
                Copy(c, collection, "name", "name");
                Copy(c, collection, "poster_path", "posterPath");
                Copy(c, collection, "backdrop_path", "backdropPath");
                o["collection"] = c;
            }

            o["relatedVideos"] = Videos(Obj(m, "videos"));
            Keywords(o, Obj(Obj(m, "keywords"), "keywords"));
            o["watchProviders"] = WatchProviders(Obj(m, "watch/providers"));
            return o;
        }

        /// <summary>Seerr's series details shape of a TMDB series read with <see cref="SeriesAppend"/>.</summary>
        /// <param name="s">TMDB's series.</param>
        /// <param name="tvdb">The TVDB id the library or an arr knows the series by, used when TMDB has none.</param>
        /// <param name="imdb">The IMDb id the library or an arr knows the series by, used when TMDB has none.</param>
        /// <returns>The details.</returns>
        internal static JsonObject Series(JsonElement s, int? tvdb = null, string? imdb = null)
        {
            var o = new JsonObject();
            Copy(o, s, "id", "id");
            Copy(o, s, "name", "name");
            Copy(o, s, "original_name", "originalName");
            Copy(o, s, "overview", "overview");
            Copy(o, s, "tagline", "tagline");
            Copy(o, s, "first_air_date", "firstAirDate");
            Copy(o, s, "last_air_date", "lastAirDate");
            Copy(o, s, "status", "status");
            Copy(o, s, "type", "type");
            Copy(o, s, "homepage", "homepage");
            Copy(o, s, "in_production", "inProduction");
            Copy(o, s, "number_of_episodes", "numberOfEpisodes");
            Copy(o, s, "number_of_seasons", "numberOfSeasons");
            Copy(o, s, "original_language", "originalLanguage");
            Copy(o, s, "popularity", "popularity");
            Copy(o, s, "vote_average", "voteAverage");
            Copy(o, s, "vote_count", "voteCount");
            Copy(o, s, "poster_path", "posterPath");
            Copy(o, s, "backdrop_path", "backdropPath");
            Raw(o, s, "episode_run_time", "episodeRunTime");
            Raw(o, s, "languages", "languages");
            Raw(o, s, "origin_country", "originCountry");
            Named(o, s, "genres", "genres");
            Companies(o, s, "networks", "networks");
            Companies(o, s, "production_companies", "productionCompanies");
            Raw(o, s, "production_countries", "productionCountries");
            Languages(o, s);
            if (Obj(s, "created_by") is { ValueKind: JsonValueKind.Array } creators)
            {
                var list = new JsonArray();
                foreach (var c in creators.EnumerateArray())
                {
                    if (Int(c, "id") is not > 0) continue;
                    var p = new JsonObject();
                    Copy(p, c, "id", "id");
                    Copy(p, c, "credit_id", "creditId");
                    Copy(p, c, "name", "name");
                    Copy(p, c, "gender", "gender");
                    Copy(p, c, "profile_path", "profilePath");
                    list.Add(p);
                }

                o["createdBy"] = list;
            }

            if (Obj(s, "last_episode_to_air") is { ValueKind: JsonValueKind.Object } last) o["lastEpisodeToAir"] = Episode(last);
            if (Obj(s, "next_episode_to_air") is { ValueKind: JsonValueKind.Object } next) o["nextEpisodeToAir"] = Episode(next);
            if (Obj(s, "seasons") is { ValueKind: JsonValueKind.Array } seasons)
            {
                var list = new JsonArray();
                foreach (var season in seasons.EnumerateArray())
                {
                    if (Int(season, "season_number") is not >= 0) continue;
                    var n = new JsonObject();
                    Copy(n, season, "id", "id");
                    Copy(n, season, "season_number", "seasonNumber");
                    Copy(n, season, "name", "name");
                    Copy(n, season, "overview", "overview");
                    Copy(n, season, "air_date", "airDate");
                    Copy(n, season, "episode_count", "episodeCount");
                    Copy(n, season, "poster_path", "posterPath");
                    list.Add(n);
                }

                o["seasons"] = list;
            }

            var external = Obj(s, "external_ids");
            var ownImdb = Str(external, "imdb_id") ?? imdb;
            var ownTvdb = Int(external, "tvdb_id") is int t and > 0 ? t : tvdb;
            o["externalIds"] = ExternalIds(external, ownImdb, ownTvdb);
            Raw(o, s, "content_ratings", "contentRatings");
            o["credits"] = Credits(Obj(s, "credits"));
            o["relatedVideos"] = Videos(Obj(s, "videos"));
            Keywords(o, Obj(Obj(s, "keywords"), "results"));
            o["watchProviders"] = WatchProviders(Obj(s, "watch/providers"));
            return o;
        }

        /// <summary>Seerr's season shape of a TMDB season (with its episodes).</summary>
        /// <param name="season">TMDB's season.</param>
        /// <returns>The season.</returns>
        internal static JsonObject Season(JsonElement season)
        {
            var o = new JsonObject();
            Copy(o, season, "id", "id");
            Copy(o, season, "season_number", "seasonNumber");
            Copy(o, season, "name", "name");
            Copy(o, season, "overview", "overview");
            Copy(o, season, "air_date", "airDate");
            Copy(o, season, "poster_path", "posterPath");
            var episodes = new JsonArray();
            if (Obj(season, "episodes") is { ValueKind: JsonValueKind.Array } list)
            {
                foreach (var e in list.EnumerateArray())
                {
                    if (e.ValueKind == JsonValueKind.Object) episodes.Add(Episode(e));
                }
            }

            o["episodes"] = episodes;
            return o;
        }

        /// <summary>Seerr's person shape of a TMDB person.</summary>
        /// <param name="p">TMDB's person.</param>
        /// <returns>The person.</returns>
        internal static JsonObject Person(JsonElement p)
        {
            var o = new JsonObject();
            Copy(o, p, "id", "id");
            Copy(o, p, "name", "name");
            Copy(o, p, "biography", "biography");
            Copy(o, p, "birthday", "birthday");
            Copy(o, p, "deathday", "deathday");
            Copy(o, p, "place_of_birth", "placeOfBirth");
            Copy(o, p, "known_for_department", "knownForDepartment");
            Copy(o, p, "gender", "gender");
            Copy(o, p, "popularity", "popularity");
            Copy(o, p, "profile_path", "profilePath");
            Copy(o, p, "adult", "adult");
            Copy(o, p, "imdb_id", "imdbId");
            Copy(o, p, "homepage", "homepage");
            Raw(o, p, "also_known_as", "alsoKnownAs");
            return o;
        }

        /// <summary>Seerr's combined-credits shape of a person's TMDB combined credits.</summary>
        /// <param name="credits">TMDB's combined credits.</param>
        /// <returns>The credits (cast and crew rows, each naming its media type).</returns>
        internal static JsonObject PersonCredits(JsonElement credits)
        {
            var o = new JsonObject();
            Copy(o, credits, "id", "id");
            o["cast"] = Rows(Obj(credits, "cast"), null);
            o["crew"] = Rows(Obj(credits, "crew"), null);
            return o;
        }

        /// <summary>
        /// Seerr's paged list shape (discovery, similar, recommendations, keyword search) of a TMDB page.
        /// </summary>
        /// <param name="page">TMDB's page.</param>
        /// <param name="mediaType">The media type of rows that don't name one (a movie or series list), or null.</param>
        /// <returns>The page.</returns>
        internal static JsonObject Page(JsonElement page, string? mediaType)
        {
            var o = new JsonObject
            {
                ["page"] = Int(page, "page") ?? 1,
                ["totalPages"] = Int(page, "total_pages") ?? 1,
                ["totalResults"] = Int(page, "total_results") ?? 0,
                ["results"] = Rows(Obj(page, "results"), mediaType),
            };
            return o;
        }

        /// <summary>Seerr's keyword search shape (id and name only) of a TMDB keyword search page.</summary>
        /// <param name="page">TMDB's page.</param>
        /// <returns>The page.</returns>
        internal static JsonObject KeywordPage(JsonElement page)
        {
            var results = new JsonArray();
            if (Obj(page, "results") is { ValueKind: JsonValueKind.Array } rows)
            {
                foreach (var row in rows.EnumerateArray())
                {
                    if (Int(row, "id") is int id and > 0 && Str(row, "name") is { } name) results.Add(new JsonObject { ["id"] = id, ["name"] = name });
                }
            }

            return new JsonObject
            {
                ["page"] = Int(page, "page") ?? 1,
                ["totalPages"] = Int(page, "total_pages") ?? 1,
                ["totalResults"] = Int(page, "total_results") ?? 0,
                ["results"] = results,
            };
        }

        /// <summary>Seerr's collection shape of a TMDB collection (its parts are movies).</summary>
        /// <param name="c">TMDB's collection.</param>
        /// <returns>The collection.</returns>
        internal static JsonObject Collection(JsonElement c)
        {
            var o = new JsonObject();
            Copy(o, c, "id", "id");
            Copy(o, c, "name", "name");
            Copy(o, c, "overview", "overview");
            Copy(o, c, "poster_path", "posterPath");
            Copy(o, c, "backdrop_path", "backdropPath");
            o["parts"] = Rows(Obj(c, "parts"), "movie", movieOnly: true);
            return o;
        }

        /// <summary>Seerr's genre list (a bare array of id and name) of TMDB's genre list.</summary>
        /// <param name="list">TMDB's genre list.</param>
        /// <returns>The genres.</returns>
        internal static JsonArray Genres(JsonElement list)
        {
            var genres = new JsonArray();
            if (Obj(list, "genres") is { ValueKind: JsonValueKind.Array } rows)
            {
                foreach (var g in rows.EnumerateArray())
                {
                    if (Int(g, "id") is int id and > 0 && Str(g, "name") is { Length: > 0 } name) genres.Add(new JsonObject { ["id"] = id, ["name"] = name });
                }
            }

            return genres;
        }

        /// <summary>Seerr's studio (company) or network shape of a TMDB company or network.</summary>
        /// <param name="c">TMDB's company or network.</param>
        /// <returns>The studio or network.</returns>
        internal static JsonObject Company(JsonElement c)
        {
            var o = new JsonObject();
            Copy(o, c, "id", "id");
            Copy(o, c, "name", "name");
            Copy(o, c, "description", "description");
            Copy(o, c, "headquarters", "headquarters");
            Copy(o, c, "homepage", "homepage");
            Copy(o, c, "logo_path", "logoPath");
            Copy(o, c, "origin_country", "originCountry");
            return o;
        }

        private static JsonObject Episode(JsonElement e)
        {
            var o = new JsonObject();
            Copy(o, e, "id", "id");
            Copy(o, e, "name", "name");
            Copy(o, e, "overview", "overview");
            Copy(o, e, "air_date", "airDate");
            Copy(o, e, "episode_number", "episodeNumber");
            Copy(o, e, "season_number", "seasonNumber");
            Copy(o, e, "show_id", "showId");
            Copy(o, e, "production_code", "productionCode");
            Copy(o, e, "runtime", "runtime");
            Copy(o, e, "still_path", "stillPath");
            Copy(o, e, "vote_average", "voteAverage");
            Copy(o, e, "vote_count", "voteCount");
            return o;
        }

        private static JsonArray Rows(JsonElement rows, string? mediaType, bool movieOnly = false)
        {
            var list = new JsonArray();
            if (rows.ValueKind != JsonValueKind.Array) return list;
            foreach (var row in rows.EnumerateArray())
            {
                if (Int(row, "id") is not > 0) continue;
                var kind = Str(row, "media_type") ?? mediaType;
                if (movieOnly && kind != "movie") continue;
                var o = new JsonObject();
                Copy(o, row, "id", "id");
                if (kind != null) o["mediaType"] = kind;
                Copy(o, row, "title", "title");
                Copy(o, row, "original_title", "originalTitle");
                Copy(o, row, "name", "name");
                Copy(o, row, "original_name", "originalName");
                Copy(o, row, "overview", "overview");
                Copy(o, row, "release_date", "releaseDate");
                Copy(o, row, "first_air_date", "firstAirDate");
                Copy(o, row, "original_language", "originalLanguage");
                Copy(o, row, "poster_path", "posterPath");
                Copy(o, row, "backdrop_path", "backdropPath");
                Copy(o, row, "profile_path", "profilePath");
                Copy(o, row, "popularity", "popularity");
                Copy(o, row, "vote_average", "voteAverage");
                Copy(o, row, "vote_count", "voteCount");
                Copy(o, row, "adult", "adult");
                Copy(o, row, "video", "video");
                Raw(o, row, "genre_ids", "genreIds");
                Raw(o, row, "origin_country", "originCountry");
                // A filmography's rows: the person's part in the title.
                Copy(o, row, "character", "character");
                Copy(o, row, "job", "job");
                Copy(o, row, "department", "department");
                Copy(o, row, "credit_id", "creditId");
                Copy(o, row, "episode_count", "episodeCount");
                list.Add(o);
            }

            return list;
        }

        private static JsonObject Credits(JsonElement credits)
        {
            var cast = new JsonArray();
            if (Obj(credits, "cast") is { ValueKind: JsonValueKind.Array } c)
            {
                foreach (var row in c.EnumerateArray())
                {
                    if (Int(row, "id") is not > 0) continue;
                    var p = new JsonObject();
                    Copy(p, row, "id", "id");
                    Copy(p, row, "cast_id", "castId");
                    Copy(p, row, "credit_id", "creditId");
                    Copy(p, row, "name", "name");
                    Copy(p, row, "character", "character");
                    Copy(p, row, "gender", "gender");
                    Copy(p, row, "order", "order");
                    Copy(p, row, "profile_path", "profilePath");
                    cast.Add(p);
                }
            }

            var crew = new JsonArray();
            if (Obj(credits, "crew") is { ValueKind: JsonValueKind.Array } w)
            {
                foreach (var row in w.EnumerateArray())
                {
                    if (Int(row, "id") is not > 0) continue;
                    var p = new JsonObject();
                    Copy(p, row, "id", "id");
                    Copy(p, row, "credit_id", "creditId");
                    Copy(p, row, "name", "name");
                    Copy(p, row, "job", "job");
                    Copy(p, row, "department", "department");
                    Copy(p, row, "gender", "gender");
                    Copy(p, row, "profile_path", "profilePath");
                    crew.Add(p);
                }
            }

            return new JsonObject { ["cast"] = cast, ["crew"] = crew };
        }

        private static JsonObject ExternalIds(JsonElement external, string? imdb, int? tvdb)
        {
            var o = new JsonObject();
            if (!string.IsNullOrEmpty(imdb)) o["imdbId"] = imdb;
            if (tvdb is > 0) o["tvdbId"] = tvdb.Value;
            Copy(o, external, "facebook_id", "facebookId");
            Copy(o, external, "instagram_id", "instagramId");
            Copy(o, external, "twitter_id", "twitterId");
            Copy(o, external, "tvrage_id", "tvrageId");
            return o;
        }

        private static JsonArray Videos(JsonElement videos)
        {
            var list = new JsonArray();
            if (Obj(videos, "results") is not { ValueKind: JsonValueKind.Array } rows) return list;
            foreach (var v in rows.EnumerateArray())
            {
                var site = Str(v, "site");
                var key = Str(v, "key");
                if (string.IsNullOrEmpty(site) || string.IsNullOrEmpty(key)) continue;
                var o = new JsonObject { ["site"] = site, ["key"] = key };
                Copy(o, v, "name", "name");
                Copy(o, v, "type", "type");
                Copy(o, v, "size", "size");
                if (site == "YouTube") o["url"] = "https://www.youtube.com/watch?v=" + Uri.EscapeDataString(key);
                list.Add(o);
            }

            return list;
        }

        private static JsonArray WatchProviders(JsonElement providers)
        {
            var list = new JsonArray();
            if (Obj(providers, "results") is not { ValueKind: JsonValueKind.Object } regions) return list;
            foreach (var region in regions.EnumerateObject())
            {
                if (region.Value.ValueKind != JsonValueKind.Object) continue;
                var o = new JsonObject { ["iso_3166_1"] = region.Name };
                Copy(o, region.Value, "link", "link");
                foreach (var kind in new[] { "flatrate", "buy", "rent" })
                {
                    if (Obj(region.Value, kind) is not { ValueKind: JsonValueKind.Array } offers) continue;
                    var mapped = new JsonArray();
                    foreach (var p in offers.EnumerateArray())
                    {
                        if (Int(p, "provider_id") is not int id) continue;
                        var n = new JsonObject { ["id"] = id };
                        Copy(n, p, "provider_name", "name");
                        Copy(n, p, "logo_path", "logoPath");
                        Copy(n, p, "display_priority", "displayPriority");
                        mapped.Add(n);
                    }

                    o[kind] = mapped;
                }

                list.Add(o);
            }

            return list;
        }

        private static void Keywords(JsonObject o, JsonElement keywords)
        {
            if (keywords.ValueKind != JsonValueKind.Array) return;
            var list = new JsonArray();
            foreach (var k in keywords.EnumerateArray())
            {
                if (Int(k, "id") is int id and > 0 && Str(k, "name") is { Length: > 0 } name) list.Add(new JsonObject { ["id"] = id, ["name"] = name });
            }

            o["keywords"] = list;
        }

        private static void Named(JsonObject o, JsonElement e, string from, string to)
        {
            if (Obj(e, from) is not { ValueKind: JsonValueKind.Array } rows) return;
            var list = new JsonArray();
            foreach (var row in rows.EnumerateArray())
            {
                if (Int(row, "id") is int id && Str(row, "name") is { Length: > 0 } name) list.Add(new JsonObject { ["id"] = id, ["name"] = name });
            }

            o[to] = list;
        }

        private static void Companies(JsonObject o, JsonElement e, string from, string to)
        {
            if (Obj(e, from) is not { ValueKind: JsonValueKind.Array } rows) return;
            var list = new JsonArray();
            foreach (var row in rows.EnumerateArray())
            {
                if (Int(row, "id") is not > 0 || Str(row, "name") is not { Length: > 0 }) continue;
                list.Add(Company(row));
            }

            o[to] = list;
        }

        private static void Languages(JsonObject o, JsonElement e)
        {
            if (Obj(e, "spoken_languages") is not { ValueKind: JsonValueKind.Array } rows) return;
            var list = new JsonArray();
            foreach (var row in rows.EnumerateArray())
            {
                var n = new JsonObject();
                Copy(n, row, "english_name", "englishName");
                Copy(n, row, "iso_639_1", "iso_639_1");
                Copy(n, row, "name", "name");
                list.Add(n);
            }

            o["spokenLanguages"] = list;
        }

        /// <summary>Copies a string, number or boolean (a null or missing value is left out).</summary>
        private static void Copy(JsonObject o, JsonElement e, string from, string to)
        {
            switch (Obj(e, from))
            {
                case { ValueKind: JsonValueKind.String } s:
                    o[to] = s.GetString();
                    break;
                case { ValueKind: JsonValueKind.Number } n:
                    o[to] = n.TryGetInt64(out var whole) ? JsonValue.Create(whole) : JsonValue.Create(n.GetDouble());
                    break;
                case { ValueKind: JsonValueKind.True }:
                    o[to] = true;
                    break;
                case { ValueKind: JsonValueKind.False }:
                    o[to] = false;
                    break;
            }
        }

        /// <summary>Copies an array or object as it is (a value of another kind is left out).</summary>
        private static void Raw(JsonObject o, JsonElement e, string from, string to)
        {
            if (Obj(e, from) is { ValueKind: JsonValueKind.Array or JsonValueKind.Object } v) o[to] = JsonNode.Parse(v.GetRawText());
        }

        private static JsonElement Obj(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

        private static string? Str(JsonElement e, string name)
            => Obj(e, name) is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

        private static int? Int(JsonElement e, string name)
            => Obj(e, name) is { ValueKind: JsonValueKind.Number } v && v.TryGetInt32(out var i) ? i : null;
    }
}
