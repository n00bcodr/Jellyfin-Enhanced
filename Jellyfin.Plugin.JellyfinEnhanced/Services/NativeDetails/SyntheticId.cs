using System;
using System.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>What a synthetic details id names.</summary>
    public enum SyntheticKind
    {
        /// <summary>A movie (TMDB movie id).</summary>
        Movie = 1,

        /// <summary>A series (TMDB tv id).</summary>
        Series = 2,

        /// <summary>A season of a series (TMDB tv id + season number).</summary>
        Season = 3,

        /// <summary>An episode (TMDB tv id + season + episode number).</summary>
        Episode = 4,

        /// <summary>A cast or crew member (TMDB person id); artwork only, never a details page.</summary>
        Person = 5,
    }

    /// <summary>
    /// A synthetic GUID for a title that is not in the library. It is decodable on its own (no
    /// registry, nothing persisted), so a cold deep link or a reload rebuilds the page from the id
    /// alone. Layout of the 32 hex digits ("N" format):
    /// <c>4a45ad</c> namespace, <c>1</c> version, kind (1 digit), TMDB id (8), season (4),
    /// episode (4), then an FNV-1a check (8) over the server id and the first 24 digits. The check
    /// binds the id to this server (two servers never share one) and, with the namespace, makes a
    /// clash with a real Jellyfin item id (an MD5-derived GUID) a 2^-56 event; the facade still
    /// lets a real item with the same id win.
    /// The web client computes the same id (js/jellyseerr/nativedetails/native-details.js).
    /// </summary>
    public readonly record struct SyntheticId(SyntheticKind Kind, int TmdbId, int Season, int Episode)
    {
        /// <summary>Namespace prefix (the first six hex digits).</summary>
        public const string Namespace = "4a45ad";

        /// <summary>Current id format version (seventh hex digit).</summary>
        public const char Version = '1';

        private const int NamespaceValue = 0x4a45ad;

        /// <summary>A movie id.</summary>
        public static SyntheticId Movie(int tmdb) => new(SyntheticKind.Movie, tmdb, 0, 0);

        /// <summary>A series id.</summary>
        public static SyntheticId Series(int tmdb) => new(SyntheticKind.Series, tmdb, 0, 0);

        /// <summary>A season id.</summary>
        public static SyntheticId SeasonOf(int tmdb, int season) => new(SyntheticKind.Season, tmdb, season, 0);

        /// <summary>An episode id.</summary>
        public static SyntheticId EpisodeOf(int tmdb, int season, int episode) => new(SyntheticKind.Episode, tmdb, season, episode);

        /// <summary>A person (artwork owner) id.</summary>
        public static SyntheticId Person(int tmdb) => new(SyntheticKind.Person, tmdb, 0, 0);

        /// <summary>True for a movie.</summary>
        public bool IsMovie => Kind == SyntheticKind.Movie;

        /// <summary>The series this id belongs to (itself for a series; movies and people have none).</summary>
        public SyntheticId SeriesId => Series(TmdbId);

        /// <summary>The season this id belongs to (seasons and episodes).</summary>
        public SyntheticId SeasonId => SeasonOf(TmdbId, Season);

        /// <summary>The 32-digit form for this server.</summary>
        /// <param name="serverId">The server's id (Jellyfin's SystemId).</param>
        /// <returns>The id in "N" format.</returns>
        public string Format(string serverId)
        {
            var prefix = Prefix();
            return prefix + Check(serverId, prefix).ToString("x8", CultureInfo.InvariantCulture);
        }

        /// <summary>The GUID for this server.</summary>
        /// <param name="serverId">The server's id.</param>
        /// <returns>The GUID.</returns>
        public Guid ToGuid(string serverId) => Guid.ParseExact(Format(serverId), "N");

        /// <summary>
        /// Cheap pre-check (no allocation): true when the GUID carries the synthetic namespace.
        /// A true answer still needs <see cref="TryParse(Guid, string, out SyntheticId)"/>.
        /// </summary>
        /// <param name="id">Any GUID.</param>
        /// <returns>True when it may be synthetic.</returns>
        public static bool HasNamespace(Guid id)
        {
            Span<byte> bytes = stackalloc byte[16];
            if (!id.TryWriteBytes(bytes)) return false;
            // The first eight "N" digits are the little-endian first int.
            var first = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
            return (int)((uint)first >> 8) == NamespaceValue;
        }

        /// <summary>Decodes and verifies a synthetic id for this server.</summary>
        /// <param name="id">The GUID.</param>
        /// <param name="serverId">The server's id.</param>
        /// <param name="value">The decoded id.</param>
        /// <returns>True when the GUID is a valid synthetic id of this server.</returns>
        public static bool TryParse(Guid id, string serverId, out SyntheticId value)
        {
            value = default;
            if (!HasNamespace(id)) return false;
            return TryParse(id.ToString("N"), serverId, out value);
        }

        /// <summary>Decodes and verifies a synthetic id given as text (dashed or not).</summary>
        /// <param name="text">The id.</param>
        /// <param name="serverId">The server's id.</param>
        /// <param name="value">The decoded id.</param>
        /// <returns>True when the text is a valid synthetic id of this server.</returns>
        public static bool TryParse(string? text, string serverId, out SyntheticId value)
        {
            value = default;
            if (text == null || !Guid.TryParse(text, out var guid)) return false;
            var n = guid.ToString("N");
            if (!n.StartsWith(Namespace, StringComparison.Ordinal) || n[6] != Version) return false;
            if (!int.TryParse(n.AsSpan(7, 1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var kind)
                || !int.TryParse(n.AsSpan(8, 8), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var tmdb)
                || !int.TryParse(n.AsSpan(16, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var season)
                || !int.TryParse(n.AsSpan(20, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var episode)
                || !uint.TryParse(n.AsSpan(24, 8), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var check))
            {
                return false;
            }

            if (check != Check(serverId, n.Substring(0, 24))) return false;
            var candidate = new SyntheticId((SyntheticKind)kind, tmdb, season, episode);
            if (!candidate.IsWellFormed()) return false;
            value = candidate;
            return true;
        }

        /// <summary>True when kind and coordinates agree (no season on a movie, an episode number on an episode, ...).</summary>
        /// <returns>Well formed.</returns>
        public bool IsWellFormed()
        {
            if (TmdbId <= 0 || Season < 0 || Episode < 0 || Season > 0xffff || Episode > 0xffff) return false;
            return Kind switch
            {
                SyntheticKind.Movie or SyntheticKind.Series or SyntheticKind.Person => Season == 0 && Episode == 0,
                SyntheticKind.Season => Episode == 0,
                SyntheticKind.Episode => true,
                _ => false,
            };
        }

        private string Prefix()
            => Namespace + Version
               + ((int)Kind).ToString("x1", CultureInfo.InvariantCulture)
               + TmdbId.ToString("x8", CultureInfo.InvariantCulture)
               + Season.ToString("x4", CultureInfo.InvariantCulture)
               + Episode.ToString("x4", CultureInfo.InvariantCulture);

        /// <summary>FNV-1a (32-bit) over the normalised server id, '|' and the 24-digit prefix.</summary>
        /// <param name="serverId">The server's id.</param>
        /// <param name="prefix">The first 24 digits.</param>
        /// <returns>The check value.</returns>
        internal static uint Check(string serverId, string prefix)
        {
            unchecked
            {
                uint hash = 2166136261;
                foreach (var c in NormaliseServerId(serverId))
                {
                    hash ^= c;
                    hash *= 16777619;
                }

                hash ^= '|';
                hash *= 16777619;
                foreach (var c in prefix)
                {
                    hash ^= c;
                    hash *= 16777619;
                }

                return hash;
            }
        }

        /// <summary>Lower-case server id without dashes (the web client uses the same form).</summary>
        /// <param name="serverId">The server id.</param>
        /// <returns>The normalised id.</returns>
        internal static string NormaliseServerId(string? serverId)
            => (serverId ?? string.Empty).Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();
    }
}
