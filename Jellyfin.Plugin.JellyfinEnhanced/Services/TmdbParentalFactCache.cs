using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The remote parental facts of a title as TMDB gave them (certification text, adult flag, keyword and genre
    /// names), kept in the server-side cache's <c>tmdbparental</c> namespace so a restart doesn't ask TMDB again for a
    /// title already verified. Facts only, never a decision: no score, signature, generation, policy, viewer or local
    /// (Jellyfin) rating or tag is stored, and each use is scored and judged afresh by <see cref="SeerrParentalFilter"/>
    /// under the generation it captured. Only complete, scorable, non-adult answers are kept (the gate says so), for
    /// at most 24 hours from the original TMDB read, never renewed. A record with tags satisfies a rating-only read
    /// too; a rating-only record never satisfies a tags read. Keys are hashes of the provider, parser version, source
    /// fingerprint (no credential), title, region, language and completeness.
    /// </summary>
    public sealed class TmdbParentalFactCache
    {
        /// <summary>The server-side cache namespace of remote parental facts.</summary>
        internal const string Namespace = "tmdbparental";

        /// <summary>Longest a record is valid after its TMDB read.</summary>
        internal static readonly TimeSpan MaxTtl = TimeSpan.FromHours(24);

        private const int Schema = 1;
        // Bump when TitleParentalEvidenceProvider's TMDB parsing or extractors change what a record means.
        private const string Parser = "je-tmdb-evidence-1";
        private const string Language = "en-US";
        private const long MaxBytes = 128L * 1024 * 1024;
        private const int MaxEntryBytes = 256 * 1024;
        private const int MaxNames = 1000;
        private const int MaxNameLength = 256;

        private readonly ServerBlobCache? _disk;
        private readonly Func<DateTime> _now;

        /// <summary>Creates the cache over the server-side cache (null: never stores anything).</summary>
        /// <param name="disk">The server-side cache.</param>
        public TmdbParentalFactCache(ServerBlobCache? disk)
            : this(disk, null)
        {
        }

        /// <summary>Creates the cache with a clock (tests).</summary>
        internal TmdbParentalFactCache(ServerBlobCache? disk, Func<DateTime>? now)
        {
            _disk = disk;
            _now = now ?? (() => DateTime.UtcNow);
            _disk?.Register(new ServerCacheNamespace(Namespace, MaxBytes, MaxTtl, MaxEntryBytes));
        }

        /// <summary>The store's generation, captured before a record's inputs are read (0 without a store).</summary>
        internal long Generation => _disk?.Generation ?? 0;

        /// <summary>
        /// The stored facts of a title for <paramref name="region"/>, or null: a tags read takes only a tags record, a
        /// rating-only read a tags record first, then a rating-only one. Never contacts TMDB.
        /// </summary>
        internal async Task<TitleParentalEvidence?> ReadAsync(string scope, string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
        {
            if (_disk == null || !_disk.Enabled) return null;
            return await ReadVariantAsync(scope, mediaType, tmdbId, region, true, ct).ConfigureAwait(false)
                ?? (needTags ? null : await ReadVariantAsync(scope, mediaType, tmdbId, region, false, ct).ConfigureAwait(false));
        }

        private async Task<TitleParentalEvidence?> ReadVariantAsync(string scope, string mediaType, int tmdbId, string region, bool tags, CancellationToken ct)
        {
            var found = await _disk!.TryGetJsonAsync<Record>(Namespace, Key(scope, mediaType, tmdbId, region, tags), null, ct).ConfigureAwait(false);
            if (found?.Value is not { } record || !Valid(record, scope, mediaType, tmdbId, region, tags, _now())) return null;
            return new TitleParentalEvidence(record.Certification, record.EvidenceRegion!, tags ? record.Keywords : null, tags ? record.Genres : null, false)
            {
                ReadAtUtc = new DateTime(Math.Min(record.RatingReadAt, record.TagsReadAt ?? long.MaxValue), DateTimeKind.Utc),
                ExpiresAtUtc = new DateTime(record.ExpiresAt, DateTimeKind.Utc),
            };
        }

        /// <summary>
        /// Stores verified facts: only when the store is on, the evidence is non-adult with a certification, its TMDB read
        /// time is known, and (for a tags record) its keyword and genre sets are complete. Refused when a Clear, Forget or
        /// settings change happened after <paramref name="evidence"/>'s generation was captured.
        /// </summary>
        internal Task<bool> WriteAsync(string scope, string mediaType, int tmdbId, string region, TitleParentalEvidence evidence, bool tags, TimeSpan ttl)
        {
            if (_disk == null || evidence.Adult != false || string.IsNullOrWhiteSpace(evidence.Certification) || evidence.ReadAtUtc is not { } readAt
                || evidence.FactsGeneration is not { } generation || (tags && (evidence.Keywords == null || evidence.Genres == null)))
            {
                return Task.FromResult(false);
            }

            var expires = readAt + (ttl < MaxTtl ? ttl : MaxTtl);
            var record = new Record
            {
                Schema = Schema, Parser = Parser, Scope = scope, Kind = mediaType, Id = tmdbId, Region = region, Language = Language,
                Complete = tags ? "tags" : "rating", EvidenceRegion = evidence.Region, Certification = evidence.Certification, Adult = false,
                Keywords = tags ? evidence.Keywords : null, Genres = tags ? evidence.Genres : null,
                RatingReadAt = readAt.Ticks, TagsReadAt = tags ? readAt.Ticks : null, ExpiresAt = expires.Ticks,
            };
            if (!Valid(record, scope, mediaType, tmdbId, region, tags, _now())) return Task.FromResult(false);
            return _disk.PutJsonAsync(Namespace, Key(scope, mediaType, tmdbId, region, tags), record, null, CancellationToken.None, generation, expires, readAt);
        }

        /// <summary>Removes a title's stored facts for a region (both completeness variants) when one turned out unusable.</summary>
        internal async Task ForgetAsync(string scope, string mediaType, int tmdbId, string region)
        {
            if (_disk == null) return;
            foreach (var tags in new[] { true, false })
            {
                var key = Key(scope, mediaType, tmdbId, region, tags);
                // Forget ends the store's generation; only an entry that is there is worth it.
                if (await _disk.TryGetAsync(Namespace, key, CancellationToken.None).ConfigureAwait(false) != null)
                    await _disk.ForgetAsync(Namespace, key, CancellationToken.None).ConfigureAwait(false);
            }
        }

        private static string Key(string scope, string mediaType, int tmdbId, string region, bool tags)
        {
            var text = new StringBuilder();
            foreach (var part in new[] { "tmdb", "je", "v" + Schema.ToString(CultureInfo.InvariantCulture), Parser, scope, mediaType,
                         tmdbId.ToString(CultureInfo.InvariantCulture), region, Language, tags ? "tags" : "rating" })
                text.Append(part.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(part);
            return "tmdbparental/" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())));
        }

        /// <summary>A record of exactly this key: identity, completeness, bounded names and believable times.</summary>
        private static bool Valid(Record record, string scope, string mediaType, int tmdbId, string region, bool tags, DateTime now)
        {
            if (record.Schema != Schema || record.Parser != Parser || record.Scope != scope || record.Kind != mediaType || record.Id != tmdbId
                || record.Region != region || record.Language != Language || record.Complete != (tags ? "tags" : "rating") || record.Adult != false
                || string.IsNullOrWhiteSpace(record.EvidenceRegion) || record.EvidenceRegion.Length > 8
                || string.IsNullOrWhiteSpace(record.Certification) || record.Certification.Length > 64)
            {
                return false;
            }

            if (tags ? !Names(record.Keywords) || !Names(record.Genres) || record.TagsReadAt is not { } tagsAt || tagsAt <= 0
                     : record.Keywords != null || record.Genres != null || record.TagsReadAt != null)
            {
                return false;
            }

            if (record.RatingReadAt <= 0 || record.ExpiresAt <= 0 || record.RatingReadAt > DateTime.MaxValue.Ticks || record.ExpiresAt > DateTime.MaxValue.Ticks) return false;
            // The oldest facet's read bounds the record: never valid longer than 24 hours after it, never from the future.
            var oldest = Math.Min(record.RatingReadAt, record.TagsReadAt ?? long.MaxValue);
            var readAt = new DateTime(oldest, DateTimeKind.Utc);
            var expires = new DateTime(record.ExpiresAt, DateTimeKind.Utc);
            return readAt <= now.AddMinutes(1) && expires > now && expires <= readAt + MaxTtl;
        }

        private static bool Names(string[]? names)
            => names != null && names.Length <= MaxNames && names.All(n => !string.IsNullOrWhiteSpace(n) && n.Length <= MaxNameLength);

        /// <summary>The stored shape (public TMDB facts only).</summary>
        internal sealed class Record
        {
            [JsonPropertyName("v")] public int Schema { get; set; }
            [JsonPropertyName("parser")] public string? Parser { get; set; }
            [JsonPropertyName("scope")] public string? Scope { get; set; }
            [JsonPropertyName("kind")] public string? Kind { get; set; }
            [JsonPropertyName("id")] public int Id { get; set; }
            [JsonPropertyName("region")] public string? Region { get; set; }
            [JsonPropertyName("language")] public string? Language { get; set; }
            [JsonPropertyName("complete")] public string? Complete { get; set; }
            [JsonPropertyName("evidenceRegion")] public string? EvidenceRegion { get; set; }
            [JsonPropertyName("certification")] public string? Certification { get; set; }
            [JsonPropertyName("adult")] public bool? Adult { get; set; }
            [JsonPropertyName("keywords")] public string[]? Keywords { get; set; }
            [JsonPropertyName("genres")] public string[]? Genres { get; set; }
            [JsonPropertyName("ratingReadAt")] public long RatingReadAt { get; set; }
            [JsonPropertyName("tagsReadAt")] public long? TagsReadAt { get; set; }
            [JsonPropertyName("expiresAt")] public long ExpiresAt { get; set; }
        }
    }
}
