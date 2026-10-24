using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>
    /// Title keys: the one way the status UI, the change feed and the status routes name a title,
    /// independent of which arr instance (or Jellyfin item) holds it.
    /// <list type="bullet">
    /// <item><description><c>movie:tmdb:&lt;id&gt;</c></description></item>
    /// <item><description><c>tv:tvdb:&lt;id&gt;</c>, <c>tv:tvdb:&lt;id&gt;:s&lt;n&gt;</c>, <c>tv:tvdb:&lt;id&gt;:s&lt;n&gt;:e&lt;n&gt;</c></description></item>
    /// </list>
    /// A change to an episode also changes its season and series (see <see cref="WithParents"/>), so a
    /// page that shows only the series hears about an episode download.
    /// </summary>
    public static class ArrTitleKey
    {
        /// <summary>Longest key accepted from a client.</summary>
        public const int MaxLength = 48;

        /// <summary>A movie by its TMDB id.</summary>
        public static string Movie(int tmdbId) => "movie:tmdb:" + tmdbId.ToString(CultureInfo.InvariantCulture);

        /// <summary>A series by its TVDB id.</summary>
        public static string Series(int tvdbId) => "tv:tvdb:" + tvdbId.ToString(CultureInfo.InvariantCulture);

        /// <summary>A season of a series.</summary>
        public static string Season(int tvdbId, int season) => Series(tvdbId) + ":s" + season.ToString(CultureInfo.InvariantCulture);

        /// <summary>An episode of a series.</summary>
        public static string Episode(int tvdbId, int season, int episode) => Season(tvdbId, season) + ":e" + episode.ToString(CultureInfo.InvariantCulture);

        /// <summary>
        /// True for a well-formed key: <c>movie:tmdb:&lt;id&gt;</c>, or <c>tv:tvdb:&lt;id&gt;</c> with an optional <c>:s&lt;n&gt;</c> and
        /// then <c>:e&lt;n&gt;</c> (lower case; ids of 1-9 ASCII digits without a leading zero, seasons of up to 4 digits and episodes
        /// of up to 5, "0" allowed), and nothing else. One deterministic pass, no clock.
        /// </summary>
        public static bool IsValid(string? key)
        {
            if (string.IsNullOrEmpty(key) || key.Length > MaxLength) return false;
            var text = key.AsSpan();
            var movie = text.StartsWith("movie:tmdb:", StringComparison.Ordinal);
            if (!movie && !text.StartsWith("tv:tvdb:", StringComparison.Ordinal)) return false;
            text = text[(movie ? 11 : 8)..];
            var id = AsciiGrammar.DigitRun(text);
            if (!AsciiGrammar.IsPlainNumber(text[..id], 9, zero: false)) return false;
            text = text[id..];
            if (text.Length == 0) return true;
            if (movie || !Part(ref text, ":s", 4)) return false;
            if (text.Length == 0) return true;
            return Part(ref text, ":e", 5) && text.Length == 0;
        }

        // A ":s"/":e" part: the marker and a number of up to max digits without a leading zero ("0" itself allowed).
        private static bool Part(ref ReadOnlySpan<char> text, string marker, int max)
        {
            if (!text.StartsWith(marker, StringComparison.Ordinal)) return false;
            var digits = AsciiGrammar.DigitRun(text[2..]);
            if (!AsciiGrammar.IsPlainNumber(text.Slice(2, digits), max, zero: true)) return false;
            text = text[(2 + digits)..];
            return true;
        }

        /// <summary>
        /// The keys a change to a series, season or episode touches: the title itself, plus its season
        /// and series. A movie touches only itself.
        /// </summary>
        public static IEnumerable<string> WithParents(int tvdbId, int? season, int? episode)
        {
            if (season is int s && s >= 0)
            {
                if (episode is int e && e >= 0) yield return Episode(tvdbId, s, e);
                yield return Season(tvdbId, s);
            }
            yield return Series(tvdbId);
        }

        /// <summary>
        /// Splits a key into its media type ("movie" or "tv") and provider id. False for a malformed key.
        /// </summary>
        public static bool TryParse(string? key, out string mediaType, out int providerId, out int? season, out int? episode)
        {
            mediaType = string.Empty;
            providerId = 0;
            season = null;
            episode = null;
            if (!IsValid(key)) return false;
            var parts = key!.Split(':');
            mediaType = parts[0];
            providerId = int.Parse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture);
            if (parts.Length > 3) season = int.Parse(parts[3].AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture);
            if (parts.Length > 4) episode = int.Parse(parts[4].AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture);
            return true;
        }

        /// <summary>
        /// The feed key that changes when a user's own request list changes (a request made,
        /// answered or removed in Seerr): <c>req:u:&lt;user id, 32 hex&gt;</c>. Only that user ever
        /// hears about it (see <see cref="ArrFeedAudience"/>).
        /// </summary>
        public static string UserRequests(Guid userId) => UserRequestsPrefix + userId.ToString("N", CultureInfo.InvariantCulture);

        /// <summary>True for a <see cref="UserRequests"/> key, with the user it belongs to.</summary>
        public static bool TryParseUserRequests(string? key, out Guid userId)
        {
            userId = Guid.Empty;
            return key is { Length: 38 }
                && key.StartsWith(UserRequestsPrefix, StringComparison.Ordinal)
                && key.AsSpan(UserRequestsPrefix.Length).IndexOfAnyExcept("0123456789abcdef") < 0
                && Guid.TryParseExact(key.AsSpan(UserRequestsPrefix.Length), "N", out userId);
        }

        /// <summary>
        /// The shared feed key that changes when the Seerr request list as a whole changes state (first
        /// read, a failure, the recovery): every Requests page follows it. It carries nothing private
        /// and reaches everyone.
        /// </summary>
        public const string RequestsState = "req:state";

        /// <summary>
        /// The feed key that changes when a user's notification inbox changes (something new, read
        /// elsewhere): <c>ntf:u:&lt;user id, 32 hex&gt;</c>. Only that user ever hears about it.
        /// </summary>
        public static string UserInbox(Guid userId) => UserInboxPrefix + userId.ToString("N", CultureInfo.InvariantCulture);

        /// <summary>True for a <see cref="UserInbox"/> key, with the user it belongs to.</summary>
        public static bool TryParseUserInbox(string? key, out Guid userId)
        {
            userId = Guid.Empty;
            return key is { Length: 38 }
                && key.StartsWith(UserInboxPrefix, StringComparison.Ordinal)
                && key.AsSpan(UserInboxPrefix.Length).IndexOfAnyExcept("0123456789abcdef") < 0
                && Guid.TryParseExact(key.AsSpan(UserInboxPrefix.Length), "N", out userId);
        }

        /// <summary>
        /// The administrators' feed key: changes whenever something the hub's admin tabs show may have
        /// changed (an instance's queue, history, health, disks or library was read again, or an
        /// action was audited). It carries nothing but the change and reaches administrators only.
        /// </summary>
        public const string AdminOps = "admin:ops";

        /// <summary>
        /// True for any key the change feed carries: a title key, a user's request-list or inbox key,
        /// <see cref="RequestsState"/> or <see cref="AdminOps"/>.
        /// </summary>
        public static bool IsFeedKey(string? key)
            => IsValid(key) || TryParseUserRequests(key, out _) || TryParseUserInbox(key, out _)
                || string.Equals(key, RequestsState, StringComparison.Ordinal) || string.Equals(key, AdminOps, StringComparison.Ordinal);

        private const string UserRequestsPrefix = "req:u:";
        private const string UserInboxPrefix = "ntf:u:";

        /// <summary>The title-level key (movie or series) a key belongs to.</summary>
        public static string? TitleOf(string? key)
        {
            if (!TryParse(key, out var type, out var id, out _, out _)) return null;
            return type == "movie" ? Movie(id) : Series(id);
        }
    }
}
