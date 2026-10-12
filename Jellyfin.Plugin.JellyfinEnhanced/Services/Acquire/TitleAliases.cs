using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// Every key a title (movie or series) is known by: its own, the canonical feed key (TMDB movie,
    /// TVDB series) and the IMDb / TMDB ids the arr libraries hold for it, plus those Seerr's requests
    /// carry (a title no arr holds yet). From memory only (library snapshots, the request read model),
    /// never an arr or Seerr call. One resolver for the status (Jellyfin copies by every id), the
    /// notifications (canonical keys, interest) and the change feed's audience, so they never disagree
    /// about which Jellyfin item a title is.
    /// </summary>
    public sealed class TitleAliases
    {
        private readonly ArrStateStore _arr;
        private readonly SeerrRequestReadModel? _requests;

        /// <summary>A resolver over the arr libraries, and Seerr's requests when given (DI gives both).</summary>
        public TitleAliases(ArrStateStore arr, SeerrRequestReadModel? requests)
        {
            _arr = arr;
            _requests = requests;
        }

        /// <summary>
        /// The title's other keys (never <paramref name="key"/> itself; same kind only): from the arr
        /// libraries in memory, then Seerr's requests for it. Season and episode parts are ignored.
        /// </summary>
        public IReadOnlyList<TitleKey> Of(TitleKey key)
        {
            var title = key.Title;
            var result = new List<TitleKey>();
            var seen = new HashSet<string>(StringComparer.Ordinal) { title.ToString() };
            void Add(string? raw)
            {
                if (raw != null && seen.Add(raw) && TitleKey.Parse(raw) is { } parsed && parsed.IsMovie == title.IsMovie) result.Add(parsed);
            }
            foreach (var raw in FromArrs(title)) Add(raw);
            if (_requests != null)
            {
                foreach (var r in _requests.ForTitle(title))
                {
                    if (r.IsMovie != title.IsMovie) continue;
                    if (title.IsMovie && r.TmdbId is > 0) Add(ArrTitleKey.Movie(r.TmdbId.Value));
                    if (!title.IsMovie && r.TvdbId is > 0) Add(ArrTitleKey.Series(r.TvdbId.Value));
                    if (!title.IsMovie && r.TmdbId is > 0) Add("tv:tmdb:" + r.TmdbId.Value.ToString(CultureInfo.InvariantCulture));
                    if (!string.IsNullOrEmpty(r.ImdbId)) Add((title.IsMovie ? "movie:imdb:" : "tv:imdb:") + r.ImdbId);
                }
            }
            return result;
        }

        /// <summary>The key a title is looked at under: TMDB for a movie, TVDB for a series, when an alias names it; else the key.</summary>
        public TitleKey Canonical(TitleKey key)
        {
            if ((key.IsMovie && key.Provider == "tmdb") || (!key.IsMovie && key.Provider == "tvdb")) return key;
            var provider = key.IsMovie ? "tmdb" : "tvdb";
            return Of(key).FirstOrDefault(a => a.Provider == provider) ?? key;
        }

        /// <summary>
        /// The keys the arr libraries in memory hold the title under (its own included when an arr
        /// holds it): TMDB and IMDb for a movie; TVDB, TMDB and IMDb for a series.
        /// </summary>
        public IReadOnlyCollection<string> FromArrs(TitleKey key)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            foreach (var instance in _arr.Instances(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr))
            {
                if (_arr.PeekLibrary(instance.Id) is not { } library) continue;
                if (key.IsMovie)
                {
                    var movie = key.Provider == "tmdb" && key.NumericId is int t ? library.MovieByTmdb(t) : key.Provider == "imdb" ? library.MovieByImdb(key.Id) : null;
                    if (movie == null) continue;
                    if (movie.TmdbId is > 0) result.Add(ArrTitleKey.Movie(movie.TmdbId.Value));
                    if (!string.IsNullOrEmpty(movie.ImdbId)) result.Add("movie:imdb:" + movie.ImdbId);
                }
                else
                {
                    var series = key.Provider switch
                    {
                        "tvdb" when key.NumericId is int tv => library.SeriesByTvdb(tv),
                        "tmdb" when key.NumericId is int tm => library.SeriesByTmdb(tm),
                        "imdb" => library.SeriesByImdb(key.Id),
                        _ => null,
                    };
                    if (series == null) continue;
                    if (series.TvdbId is > 0) result.Add(ArrTitleKey.Series(series.TvdbId.Value));
                    if (series.TmdbId is > 0) result.Add("tv:tmdb:" + series.TmdbId.Value.ToString(CultureInfo.InvariantCulture));
                    if (!string.IsNullOrEmpty(series.ImdbId)) result.Add("tv:imdb:" + series.ImdbId);
                }
            }
            return result;
        }
    }
}
