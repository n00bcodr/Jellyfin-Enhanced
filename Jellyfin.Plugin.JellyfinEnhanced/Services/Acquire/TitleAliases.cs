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

        /// <summary>True when the supplied facts, or the shared request model, say this user asked for the title or an alias.</summary>
        internal bool AskedBy(TitleKey key, Guid user, IArrRequestFacts? facts = null)
            => (facts ?? _requests) is { } requests && new[] { key.Title }.Concat(Of(key)).Any(k => requests.AskedBy(k, user));

        /// <summary>
        /// The title's other keys (never <paramref name="key"/> itself; same kind only): from the arr
        /// libraries in memory and Seerr's requests, following links through either source until
        /// every id is known. Season and episode parts are ignored.
        /// </summary>
        public IReadOnlyList<TitleKey> Of(TitleKey key)
        {
            var title = key.Title;
            var result = new List<TitleKey>();
            var seen = new HashSet<string>(StringComparer.Ordinal) { title.ToString() };
            var pending = new Queue<TitleKey>();
            pending.Enqueue(title);
            void Add(string? raw)
            {
                if (raw == null || !seen.Add(raw) || TitleKey.Parse(raw) is not { } parsed || parsed.IsMovie != title.IsMovie) return;
                result.Add(parsed);
                pending.Enqueue(parsed);
            }
            while (pending.TryDequeue(out var current))
            {
                foreach (var raw in FromArrs(current)) Add(raw);
                if (_requests == null) continue;
                foreach (var r in _requests.ForTitle(current))
                {
                    if (r.IsMovie != title.IsMovie) continue;
                    foreach (var raw in FromRequest(r)) Add(raw);
                }
            }
            return result;
        }

        /// <summary>
        /// Every usable title key carried by one Seerr request, in canonical-provider order.
        /// Shared by alias resolution, the request index and its change signature.
        /// </summary>
        internal static IReadOnlyList<string> FromRequest(SeerrRequestRecord request)
            => FromIds(request.IsMovie, request.TmdbId, request.TvdbId, request.ImdbId);

        /// <summary>Every usable key for these provider ids, in canonical-provider order.</summary>
        internal static IReadOnlyList<string> FromIds(bool isMovie, int? tmdbId, int? tvdbId, string? imdbId)
        {
            string? Num(int? n) => n is > 0 ? n.Value.ToString(CultureInfo.InvariantCulture) : null;
            return FromProviderIds(isMovie, Num(tmdbId), Num(tvdbId), imdbId).Select(k => k.ToString()).ToArray();
        }

        /// <summary>
        /// Validated, normalized provider keys from Jellyfin metadata, in canonical-provider order.
        /// Numeric ids must fit the arr APIs' positive integer ids; IMDb validation is shared with
        /// <see cref="TitleKey"/>. Also used by <see cref="FromIds"/> for typed arr/Seerr ids.
        /// </summary>
        internal static IReadOnlyList<TitleKey> FromProviderIds(bool isMovie, string? tmdbId, string? tvdbId, string? imdbId)
        {
            var keys = new List<TitleKey>();
            void Add(TitleKey? key)
            {
                if (key != null && (key.Provider == "imdb" || key.NumericId is > 0)) keys.Add(key);
            }
            if (isMovie)
            {
                Add(TitleKey.ForMovie(tmdbId, null));
                Add(TitleKey.ForMovie(null, imdbId));
            }
            else
            {
                Add(TitleKey.ForSeries(tvdbId, null, null));
                Add(TitleKey.ForSeries(null, tmdbId, null));
                Add(TitleKey.ForSeries(null, null, imdbId));
            }
            return keys;
        }

        /// <summary>The movie or series key carried by a calendar event, when it has a usable id.</summary>
        internal static TitleKey? KeyOf(Model.Arr.ArrItem item)
            => FromIds(item.Type == "Movie", item.TmdbId, item.TvdbId, item.ImdbId).Select(TitleKey.Parse).FirstOrDefault();

        /// <summary>
        /// Jellyfin's provider queries for a title and its aliases: one value of each provider per
        /// query, at most <paramref name="max"/> (four) queries, shared by copy lookup and the feed's batched privacy checks.
        /// </summary>
        internal static IReadOnlyList<Dictionary<string, string>> ProviderQueries(TitleKey key, IEnumerable<TitleKey> aliases, int max = 4)
            => AllProviderQueries(key, aliases).Take(max).ToList();

        /// <summary>
        /// Every provider query a title and its aliases need (one value of each provider per query, no cap): what a complete
        /// copy lookup runs.
        /// </summary>
        internal static IReadOnlyList<Dictionary<string, string>> AllProviderQueries(TitleKey key, IEnumerable<TitleKey> aliases)
        {
            var queries = new List<Dictionary<string, string>>();
            foreach (var id in new[] { key.Title }.Concat(aliases).Where(k => k.IsMovie == key.IsMovie)
                .Select(k => (Provider: ProviderName(k), k.Id)).Distinct())
            {
                var into = queries.FirstOrDefault(q => !q.ContainsKey(id.Provider));
                if (into == null) queries.Add(into = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase));
                into[id.Provider] = id.Id;
            }
            return queries;
        }

        /// <summary>The provider name Jellyfin's library queries use for a title key.</summary>
        internal static string ProviderName(TitleKey key)
            => key.Provider switch { "tmdb" => "Tmdb", "tvdb" => "Tvdb", _ => "Imdb" };

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
            // The libraries in memory (an instance without a key never has one): memory only, no secrets read.
            foreach (var instance in _arr.Registry.Usable(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr))
            {
                if (_arr.PeekLibrary(instance.Id) is not { } library) continue;
                if (key.IsMovie)
                {
                    var movie = key.Provider == "tmdb" && key.NumericId is int t ? library.MovieByTmdb(t) : key.Provider == "imdb" ? library.MovieByImdb(key.Id) : null;
                    if (movie == null) continue;
                    foreach (var raw in FromIds(true, movie.TmdbId, null, movie.ImdbId)) result.Add(raw);
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
                    foreach (var raw in FromIds(false, series.TmdbId, series.TvdbId, series.ImdbId)) result.Add(raw);
                }
            }
            return result;
        }
    }
}
