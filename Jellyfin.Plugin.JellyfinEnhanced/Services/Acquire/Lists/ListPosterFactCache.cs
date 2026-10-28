using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The validated TMDB poster facts of list placeholders (<see cref="ListMetadataService"/>'s direct TMDB poster
    /// reads), kept in the server-side cache's <c>tmdbposter</c> namespace so a restart doesn't read every placeholder's
    /// title or season from TMDB again just for its poster. A record is evidence about one TMDB resource (a movie, a show
    /// or one season of it): its poster path, or that TMDB says it has none (the explicit null). Failures, 404s, partial
    /// or unbound answers and the season-to-show fallback are never stored, nor anything about a list, a placeholder, a
    /// viewer or which poster a collage shows. Valid for 12 hours from the original read, never renewed. Keys are hashes
    /// of the API key hash, the contract version and the resource.
    /// </summary>
    public sealed class ListPosterFactCache
    {
        /// <summary>The server-side cache namespace of list poster facts.</summary>
        internal const string Namespace = "tmdbposter";

        private const int Schema = 1;
        // Bump when ResponseContract.TmdbPoster changes what a valid answer is.
        private const string Contract = "tmdb-poster-1";
        private const long MaxBytes = 16L * 1024 * 1024;
        private const int MaxEntryBytes = 4096;
        private static readonly Regex PosterPattern = new(@"^/[A-Za-z0-9_-]+\.(jpg|png)\z", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex ResourcePattern = new(@"^(movie|tv)/([0-9]{1,9})(?:/season/([0-9]{1,5}))?\z", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly ServerBlobCache? _disk;
        private readonly Func<DateTime> _now;

        /// <summary>Creates the cache over the server-side cache (null: never stores anything).</summary>
        /// <param name="disk">The server-side cache.</param>
        public ListPosterFactCache(ServerBlobCache? disk)
            : this(disk, null)
        {
        }

        /// <summary>Creates the cache with a clock (tests).</summary>
        internal ListPosterFactCache(ServerBlobCache? disk, Func<DateTime>? now)
        {
            _disk = disk;
            _now = now ?? (() => DateTime.UtcNow);
            _disk?.Register(new ServerCacheNamespace(Namespace, MaxBytes, ListMetadataService.CacheTtl, MaxEntryBytes));
        }

        /// <summary>The store's generation, captured before a poster read begins (0 without a store).</summary>
        internal long Generation => _disk?.Generation ?? 0;

        /// <summary>A saved poster fact for exactly this resource and request, or null. Never contacts TMDB.</summary>
        /// <param name="keyHash">The API key's hash (as the memory cache keys it).</param>
        /// <param name="apiPath">The resource (<c>movie/{id}</c>, <c>tv/{id}</c>, <c>tv/{id}/season/{n}</c>).</param>
        /// <param name="asked">The identity the poster read asked for.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The poster (null: TMDB says none) and the original read time, or null.</returns>
        internal async Task<(string? Poster, DateTime ReadAt)?> ReadAsync(string keyHash, string apiPath, AnswerRequest asked, CancellationToken ct)
        {
            if (_disk == null || !_disk.Enabled || Identity(apiPath, asked) == null) return null;
            var found = await _disk.TryGetJsonAsync<Record>(Namespace, Key(keyHash, apiPath), null, ct, ListMetadataService.CacheTtl).ConfigureAwait(false);
            if (found?.Value is not { } record || !Valid(record, keyHash, apiPath, asked, _now())) return null;
            return (record.Poster, new DateTime(record.ReadAt, DateTimeKind.Utc));
        }

        /// <summary>
        /// Saves a validated answer (a poster, or TMDB's explicit "none"), valid 12 hours from <paramref name="readAt"/>;
        /// refused when a Clear or settings change happened after <paramref name="generation"/> was captured.
        /// </summary>
        internal Task<bool> WriteAsync(string keyHash, string apiPath, AnswerRequest asked, string? poster, DateTime readAt, long generation)
        {
            if (_disk == null || Identity(apiPath, asked) is not { } identity) return Task.FromResult(false);
            var expires = readAt + ListMetadataService.CacheTtl;
            var record = new Record
            {
                Schema = Schema, Contract = Contract, Scope = keyHash, Resource = apiPath, Kind = identity.Kind, Id = identity.Id, Season = identity.Season,
                Poster = poster, Result = poster == null ? "none" : "poster", ReadAt = readAt.Ticks, ExpiresAt = expires.Ticks,
            };
            if (!Valid(record, keyHash, apiPath, asked, _now())) return Task.FromResult(false);
            return _disk.PutJsonAsync(Namespace, Key(keyHash, apiPath), record, null, CancellationToken.None, generation, expires, readAt);
        }

        private static string Key(string keyHash, string apiPath)
        {
            var text = new StringBuilder();
            foreach (var part in new[] { "tmdb", "v" + Schema.ToString(CultureInfo.InvariantCulture), Contract, keyHash, apiPath })
                text.Append(part.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(part);
            return "tmdbposter/" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())));
        }

        /// <summary>The resource's kind and identity when it is one the poster read asks for exactly so, else null.</summary>
        private static (string Kind, int Id, int? Season)? Identity(string apiPath, AnswerRequest asked)
        {
            var match = ResourcePattern.Match(apiPath);
            if (!match.Success || !int.TryParse(match.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var id)) return null;
            if (match.Groups[3].Success)
            {
                return match.Groups[1].Value == "tv" && int.TryParse(match.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var season)
                    && asked.Show == id && asked.Season == season && asked.Id == null ? ("season", id, season) : null;
            }

            return asked.Id == id && asked.Season == null && asked.Show == null ? (match.Groups[1].Value, id, null) : null;
        }

        private static bool Valid(Record record, string keyHash, string apiPath, AnswerRequest asked, DateTime now)
        {
            if (Identity(apiPath, asked) is not { } identity || record.Schema != Schema || record.Contract != Contract || record.Scope != keyHash
                || record.Resource != apiPath || record.Kind != identity.Kind || record.Id != identity.Id || record.Season != identity.Season)
            {
                return false;
            }

            // "No poster" only as TMDB's explicit null; a poster only as a safe TMDB path.
            if (record.Poster == null ? record.Result != "none" : record.Result != "poster" || !PosterPattern.IsMatch(record.Poster)) return false;
            if (record.ReadAt <= 0 || record.ExpiresAt <= 0 || record.ReadAt > DateTime.MaxValue.Ticks || record.ExpiresAt > DateTime.MaxValue.Ticks) return false;
            var readAt = new DateTime(record.ReadAt, DateTimeKind.Utc);
            var expires = new DateTime(record.ExpiresAt, DateTimeKind.Utc);
            return readAt <= now.AddMinutes(1) && expires > now && expires <= readAt + ListMetadataService.CacheTtl;
        }

        /// <summary>The stored shape (public TMDB facts only).</summary>
        internal sealed class Record
        {
            [JsonPropertyName("v")] public int Schema { get; set; }
            [JsonPropertyName("contract")] public string? Contract { get; set; }
            [JsonPropertyName("scope")] public string? Scope { get; set; }
            [JsonPropertyName("resource")] public string? Resource { get; set; }
            [JsonPropertyName("kind")] public string? Kind { get; set; }
            [JsonPropertyName("id")] public int Id { get; set; }
            [JsonPropertyName("season")] public int? Season { get; set; }
            [JsonPropertyName("poster")] public string? Poster { get; set; }
            [JsonPropertyName("result")] public string? Result { get; set; }
            [JsonPropertyName("readAt")] public long ReadAt { get; set; }
            [JsonPropertyName("expiresAt")] public long ExpiresAt { get; set; }
        }
    }
}
