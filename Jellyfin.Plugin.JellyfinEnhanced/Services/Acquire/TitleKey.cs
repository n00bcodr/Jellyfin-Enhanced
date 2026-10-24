using System;
using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

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

        /// <summary>
        /// Parses a key; null when it is not one. The grammar is <c>(movie|tv):(tmdb|tvdb|imdb):(tt&lt;1-12 digits&gt;|&lt;1-12
        /// digits&gt;)[:s&lt;1-4 digits&gt;[:e&lt;1-5 digits&gt;]]</c>, ASCII letters in either case and ASCII digits only, matched in one
        /// deterministic pass (a regular expression with a match timeout refused valid keys on a loaded server).
        /// </summary>
        public static TitleKey? Parse(string? value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 64) return null;
            var text = value.Trim().AsSpan();
            bool movie;
            if (AsciiGrammar.StartsWithIgnoreCase(text, "movie:")) { movie = true; text = text[6..]; }
            else if (AsciiGrammar.StartsWithIgnoreCase(text, "tv:")) { movie = false; text = text[3..]; }
            else return null;
            string provider;
            if (AsciiGrammar.StartsWithIgnoreCase(text, "tmdb:")) provider = "tmdb";
            else if (AsciiGrammar.StartsWithIgnoreCase(text, "tvdb:")) provider = "tvdb";
            else if (AsciiGrammar.StartsWithIgnoreCase(text, "imdb:")) provider = "imdb";
            else return null;
            text = text[5..];
            // The id: "tt" and 1-12 digits, or 1-12 digits.
            var prefix = AsciiGrammar.StartsWithIgnoreCase(text, "tt") ? 2 : 0;
            var digits = AsciiGrammar.DigitRun(text[prefix..]);
            if (digits is < 1 or > 12) return null;
            var id = text[..(prefix + digits)].ToString().ToLowerInvariant();
            text = text[(prefix + digits)..];
            // ":s" and 1-4 digits, then ":e" and 1-5 digits, each optional, and nothing after.
            int? season = null, episode = null;
            if (text.Length > 0)
            {
                if (!Part(ref text, 's', 4, out var s)) return null;
                season = s;
                if (text.Length > 0)
                {
                    if (!Part(ref text, 'e', 5, out var e) || text.Length > 0) return null;
                    episode = e;
                }
            }
            var isImdb = id.StartsWith("tt", StringComparison.Ordinal);
            if (isImdb != (provider == "imdb")) return null;
            if (movie && (provider == "tvdb" || season.HasValue)) return null;
            if (!isImdb) id = id.TrimStart('0') is { Length: > 0 } trimmed ? trimmed : "0";
            if (id == "0") return null;
            return new TitleKey(movie, provider, id, season, episode);
        }

        // ":<letter><1-max ASCII digits>" at the start of text (the letter in either case); moves past it.
        private static bool Part(ref ReadOnlySpan<char> text, char letter, int max, out int number)
        {
            number = 0;
            if (text.Length < 3 || text[0] != ':' || !AsciiGrammar.StartsWithIgnoreCase(text[1..], letter.ToString())) return false;
            var digits = AsciiGrammar.DigitRun(text[2..]);
            if (digits < 1 || digits > max || !int.TryParse(text.Slice(2, digits), NumberStyles.None, CultureInfo.InvariantCulture, out number)) return false;
            text = text[(2 + digits)..];
            return true;
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
