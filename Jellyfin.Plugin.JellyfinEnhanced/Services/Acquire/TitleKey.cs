using System;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// Provider-id key of a title, shared by the status routes, the client and the change feed:
    /// <c>movie:tmdb:603</c>, <c>movie:imdb:tt0133093</c>, <c>tv:tvdb:78874</c> (or
    /// <c>tv:tmdb:…</c> / <c>tv:imdb:…</c> when there is no TVDB id), a season
    /// <c>tv:tvdb:78874:s1</c> and an episode <c>tv:tvdb:78874:s1:e2</c>. The TMDB movie and TVDB
    /// series forms are the ones the change feed announces (<see cref="Arr.Live.ArrTitleKey"/>).
    /// The key names the title, not a Jellyfin item or an arr row, so every copy and every
    /// instance of the same title share it.
    /// </summary>
    public sealed class TitleKey : IEquatable<TitleKey>
    {
        private static readonly Regex Pattern = new(
            @"^(movie|tv):(tmdb|tvdb|imdb):(tt[0-9]{1,12}|[0-9]{1,12})(?::s([0-9]{1,4})(?::e([0-9]{1,5}))?)?$",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase,
            TimeSpan.FromMilliseconds(100));

        private TitleKey(bool movie, string provider, string id, int? season, int? episode)
        {
            IsMovie = movie;
            Provider = provider;
            Id = id;
            Season = season;
            Episode = episode;
        }

        /// <summary>True for a movie, false for a series (or one of its seasons/episodes).</summary>
        public bool IsMovie { get; }

        /// <summary>tmdb, tvdb or imdb.</summary>
        public string Provider { get; }

        /// <summary>The provider id (digits, or tt… for IMDb).</summary>
        public string Id { get; }

        /// <summary>Season number for a season or episode key.</summary>
        public int? Season { get; }

        /// <summary>Episode number for an episode key.</summary>
        public int? Episode { get; }

        /// <summary>movie, series, season or episode.</summary>
        public string Kind => IsMovie ? "movie" : Episode.HasValue ? "episode" : Season.HasValue ? "season" : "series";

        /// <summary>The key of the whole title (a season's or episode's series).</summary>
        public TitleKey Title => Season.HasValue ? new TitleKey(IsMovie, Provider, Id, null, null) : this;

        /// <summary>A movie key, preferring TMDB over IMDb; null without either.</summary>
        public static TitleKey? ForMovie(string? tmdb, string? imdb)
        {
            if (Digits(tmdb) is { } t) return new TitleKey(true, "tmdb", t, null, null);
            if (Imdb(imdb) is { } i) return new TitleKey(true, "imdb", i, null, null);
            return null;
        }

        /// <summary>A series key, preferring TVDB, then TMDB, then IMDb; null without any.</summary>
        public static TitleKey? ForSeries(string? tvdb, string? tmdb, string? imdb)
        {
            if (Digits(tvdb) is { } v) return new TitleKey(false, "tvdb", v, null, null);
            if (Digits(tmdb) is { } t) return new TitleKey(false, "tmdb", t, null, null);
            if (Imdb(imdb) is { } i) return new TitleKey(false, "imdb", i, null, null);
            return null;
        }

        /// <summary>The key of a season of this series.</summary>
        public TitleKey WithSeason(int season) => new(false, Provider, Id, season, null);

        /// <summary>The key of an episode of this series.</summary>
        public TitleKey WithEpisode(int season, int episode) => new(false, Provider, Id, season, episode);

        /// <summary>Parses a key; null when it is not one.</summary>
        public static TitleKey? Parse(string? value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 64) return null;
            var m = Pattern.Match(value.Trim());
            if (!m.Success) return null;
            var movie = m.Groups[1].Value.Equals("movie", StringComparison.OrdinalIgnoreCase);
            var provider = m.Groups[2].Value.ToLowerInvariant();
            var id = m.Groups[3].Value.ToLowerInvariant();
            var isImdb = id.StartsWith("tt", StringComparison.Ordinal);
            if (isImdb != (provider == "imdb")) return null;
            if (movie && (provider == "tvdb" || m.Groups[4].Success)) return null;
            // ASCII digits only ([0-9], not \d, which matches any Unicode digit int.Parse rejects).
            int? season = null, episode = null;
            if (m.Groups[4].Success)
            {
                if (!int.TryParse(m.Groups[4].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var s)) return null;
                season = s;
            }
            if (m.Groups[5].Success)
            {
                if (!int.TryParse(m.Groups[5].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var e)) return null;
                episode = e;
            }
            if (!isImdb) id = id.TrimStart('0') is { Length: > 0 } trimmed ? trimmed : "0";
            if (id == "0") return null;
            return new TitleKey(movie, provider, id, season, episode);
        }

        /// <summary>The numeric id (TMDB/TVDB), or null for IMDb keys.</summary>
        public int? NumericId => Provider != "imdb" && int.TryParse(Id, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : null;

        /// <inheritdoc />
        public override string ToString()
        {
            var s = (IsMovie ? "movie:" : "tv:") + Provider + ":" + Id;
            if (Season is int season) s += ":s" + season.ToString(CultureInfo.InvariantCulture);
            if (Episode is int episode) s += ":e" + episode.ToString(CultureInfo.InvariantCulture);
            return s;
        }

        /// <inheritdoc />
        public bool Equals(TitleKey? other) => other != null && ToString() == other.ToString();

        /// <inheritdoc />
        public override bool Equals(object? obj) => Equals(obj as TitleKey);

        /// <inheritdoc />
        public override int GetHashCode() => StringComparer.Ordinal.GetHashCode(ToString());

        private static string? Digits(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var v = value.Trim();
            if (v.Length > 12) return null;
            foreach (var c in v)
            {
                if (c < '0' || c > '9') return null;
            }
            v = v.TrimStart('0');
            return v.Length == 0 ? null : v;
        }

        private static string? Imdb(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var v = value.Trim().ToLowerInvariant();
            if (v.Length < 3 || v.Length > 14 || !v.StartsWith("tt", StringComparison.Ordinal)) return null;
            for (var i = 2; i < v.Length; i++)
            {
                if (v[i] < '0' || v[i] > '9') return null;
            }
            return v;
        }
    }
}
