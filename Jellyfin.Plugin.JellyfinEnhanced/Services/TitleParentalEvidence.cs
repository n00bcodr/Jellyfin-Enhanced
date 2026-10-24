using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// User-neutral facts, not an access decision. Null evidence is unknown; a null certification in verified
    /// evidence is known-unrated. Null tag sets are unknown, while empty sets are verified empty. Local tags
    /// are Jellyfin item tags; remote tags are TMDB keywords (genres only extend the blocked-tag direction).
    /// </summary>
    public sealed record TitleParentalEvidence(string? Certification, string Region, string[]? Keywords, string[]? Genres, bool? Adult);

    /// <summary>A captured metadata source. Its scope and credentials cannot change during a lookup.</summary>
    public interface ITitleParentalEvidence
    {
        /// <summary>Opaque cache partition for the backend and its configuration; contains no credentials.</summary>
        string CacheScope { get; }

        /// <summary>Generation captured before reading any source inputs.</summary>
        long EvidenceGeneration => EvidenceRevision.EvidenceGeneration;

        /// <summary>Reads public evidence, or null when unavailable. Never makes a per-user policy decision.</summary>
        Task<TitleParentalEvidence?> ReadAsync(string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct);

        /// <summary>Discards raw facts the scoring gate could not verify, so its short retry TTL can recover.</summary>
        void Forget(string mediaType, int tmdbId, bool needTags) { }
    }

    /// <summary>
    /// Chooses parental evidence from the request backend, independently of request rollout flags. JE reads the
    /// existing TMDB client and native library facts, never Seerr, including when old Seerr settings remain saved.
    /// All policy, bounded signature caching and unknown/refused decisions remain in <see cref="SeerrParentalFilter"/>.
    /// </summary>
    public sealed class TitleParentalEvidenceProvider
    {
        private readonly IHttpClientFactory _http;
        private readonly TmdbResponseCache _tmdb;
        private readonly ILibraryManager? _library;

        /// <summary>Creates the provider over the shared TMDB cache and native library.</summary>
        public TitleParentalEvidenceProvider(IHttpClientFactory http, TmdbResponseCache tmdb, ILibraryManager? library = null)
        {
            _http = http;
            _tmdb = tmdb;
            _library = library;
        }

        /// <summary>Captures the selected source and its configuration before a cache lookup or shared fetch.</summary>
        public ITitleParentalEvidence Capture()
        {
            JellyfinEnhanced.Instance?.Secrets.RecoverIfNeeded();
            var generation = EvidenceRevision.EvidenceGeneration;
            return new Captured(CaptureSource(), generation);
        }

        private sealed record Captured(ITitleParentalEvidence Source, long EvidenceGeneration) : ITitleParentalEvidence
        {
            public string CacheScope => Source.CacheScope;
            public Task<TitleParentalEvidence?> ReadAsync(string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
                => Source.ReadAsync(mediaType, tmdbId, region, needTags, ct);
            public void Forget(string mediaType, int tmdbId, bool needTags) => Source.Forget(mediaType, tmdbId, needTags);
        }

        private ITitleParentalEvidence CaptureSource()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return new Unavailable("off");
            var tmdbKey = config.GetTmdbApiKey() ?? string.Empty;
            if (string.Equals(config.ArrRequestBackend, "je", StringComparison.OrdinalIgnoreCase))
                return new Tmdb(_tmdb, tmdbKey);
            // Status-only disables requesting, not the legacy metadata surfaces.
            if (!SeerrMetadataMode(config.ArrRequestBackend))
                return new Unavailable("unknown-backend");
            return new Seerr(_http, _tmdb, tmdbKey, config.JellyseerrEnabled ? config.JellyseerrUrls : string.Empty,
                config.JellyseerrEnabled ? config.GetJellyseerrApiKey() : string.Empty);
        }

        private static bool SeerrMetadataMode(string? mode)
            => string.Equals(mode, "seerr", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mode, "status_only", StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Current native entitlement for broad metadata consumers. A physical copy must be returned by Jellyfin's
        /// user-scoped query and its user-scoped item read; user-neutral local facts never grant this exception.
        /// </summary>
        internal bool MayOpenLocal(string mediaType, int tmdbId, Jellyfin.Database.Implementations.Entities.User? user)
        {
            if (_library == null || user == null) return false;
            try
            {
                var id = tmdbId.ToString(CultureInfo.InvariantCulture);
                var items = _library.GetItemList(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { mediaType == "movie" ? BaseItemKind.Movie : BaseItemKind.Series },
                    HasAnyProviderId = new Dictionary<string, string> { ["Tmdb"] = id },
                    Recursive = true, IsVirtualItem = false, Limit = 33,
                });
                return items.Take(32).Any(item => EditionAvailability.Plays(ArrJellyfinView.LocalEvidenceItem(item))
                    && item.ProviderIds.TryGetValue("Tmdb", out var actual) && actual == id
                    && _library.GetItemById<BaseItem>(item.Id, user) != null);
            }
            catch (Exception) { return false; }
        }

        /// <summary>
        /// Reads authoritative local item rating/tags afresh, so native edits never inherit the remote cache TTL.
        /// Only physical movies/series with this exact TMDB id count. Conflicting copies or a capped read stay
        /// unknown; they must not be replaced with a more permissive upstream answer. This conveys no library access.
        /// Arr operational tags are not item tags; arr indexes remain authoritative only for identity/path resolution
        /// in the callers, not for certification or custom parental tags.
        /// </summary>
        public bool TryReadLocal(string mediaType, int tmdbId, string region, out TitleParentalEvidence? evidence)
        {
            evidence = null;
            if (_library == null || !string.Equals(JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend, "je", StringComparison.OrdinalIgnoreCase)) return false;
            var items = _library.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { mediaType == "movie" ? BaseItemKind.Movie : BaseItemKind.Series },
                HasAnyProviderId = new Dictionary<string, string> { ["Tmdb"] = tmdbId.ToString(CultureInfo.InvariantCulture) },
                Recursive = true,
                IsVirtualItem = false,
                Limit = 33,
            });
            if (items.Count == 0) return false;
            if (items.Count > 32) return true;
            var physical = items.Where(i => EditionAvailability.Plays(ArrJellyfinView.LocalEvidenceItem(i))
                && i.ProviderIds.TryGetValue("Tmdb", out var id) && id == tmdbId.ToString(CultureInfo.InvariantCulture)).ToArray();
            if (physical.Length == 0) return false;
            var facts = physical.Select(i => new TitleParentalEvidence(
                string.IsNullOrWhiteSpace(i.CustomRating) ? i.OfficialRating : i.CustomRating, region,
                ParentalTagDecision.ToTagSet(i.Tags).OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToArray(),
                ParentalTagDecision.ToTagSet(i.Genres).OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToArray(), null)).ToArray();
            var first = facts[0];
            if (facts.All(f => string.Equals(f.Certification, first.Certification, StringComparison.Ordinal)
                && f.Keywords!.SequenceEqual(first.Keywords!, StringComparer.OrdinalIgnoreCase)
                && f.Genres!.SequenceEqual(first.Genres!, StringComparer.OrdinalIgnoreCase))) evidence = first;
            return true;
        }

        private static string Scope(params string?[] parts)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(parts))));

        private sealed class Unavailable(string scope) : ITitleParentalEvidence
        {
            public string CacheScope => scope;
            public Task<TitleParentalEvidence?> ReadAsync(string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
                => Task.FromResult<TitleParentalEvidence?>(null);
        }

        private sealed class Tmdb(TmdbResponseCache client, string apiKey) : ITitleParentalEvidence
        {
            public string CacheScope { get; } = "je:" + Scope(apiKey);

            public void Forget(string mediaType, int tmdbId, bool needTags)
                => client.Forget(mediaType + "/" + tmdbId.ToString(CultureInfo.InvariantCulture),
                    "?language=en-US&append_to_response=" + (mediaType == "movie" ? "release_dates" : "content_ratings") + (needTags ? ",keywords" : string.Empty), apiKey);

            public async Task<TitleParentalEvidence?> ReadAsync(string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
            {
                if (string.IsNullOrWhiteSpace(apiKey)) return null;
                var ratings = mediaType == "movie" ? "release_dates" : "content_ratings";
                // English names match the established external-tag contract, independent of the viewer's language.
                var query = "?language=en-US&append_to_response=" + ratings + (needTags ? ",keywords" : string.Empty);
                var path = mediaType + "/" + tmdbId.ToString(CultureInfo.InvariantCulture);
                var response = await client.GetAsync(path, query, apiKey, ct).ConfigureAwait(false);
                if (!response.IsSuccess) return null;
                try
                {
                    using var doc = JsonDocument.Parse(response.Content);
                    var evidence = Parse(doc.RootElement, mediaType, tmdbId, region, ratings, needTags);
                    // The gate retries unknowns after five minutes; a partial 200 must not pin them in the
                    // raw client's six-hour positive cache. The gate still prevents a per-request retry storm.
                    if (evidence == null || (needTags && evidence.Adult != true && evidence.Keywords == null))
                        client.Forget(path, query, apiKey);
                    return evidence;
                }
                catch (JsonException)
                {
                    client.Forget(path, query, apiKey);
                    return null;
                }
            }

            private static TitleParentalEvidence? Parse(JsonElement detail, string mediaType, int tmdbId, string region, string ratings, bool needTags)
            {
                if (detail.ValueKind != JsonValueKind.Object || !detail.TryGetProperty("id", out var id)
                    || id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out var actualId) || actualId != tmdbId
                    || !detail.TryGetProperty("adult", out var adult) || adult.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
                if (adult.GetBoolean()) return new(null, region, null, null, true);
                if (!detail.TryGetProperty(ratings, out var certifications) || !ValidRatings(certifications, mediaType)) return null;
                var cert = SeerrCertificationExtractor.Extract(certifications, mediaType, region);
                string[]? keywords = null;
                string[]? genres = null;
                if (needTags && detail.TryGetProperty("keywords", out var container)
                    && container.ValueKind == JsonValueKind.Object
                    && container.TryGetProperty(mediaType == "movie" ? "keywords" : "results", out var words)
                    && ValidNames(words) && detail.TryGetProperty("genres", out var genreList) && ValidNames(genreList))
                {
                    var tags = SeerrTagSignatureExtractor.Extract(detail);
                    keywords = tags.Keywords.ToArray(); genres = tags.Genres.ToArray();
                }
                return new(cert.Certification, cert.Iso ?? region, keywords, genres, adult.GetBoolean());
            }

            private static bool ValidNames(JsonElement array)
                => array.ValueKind == JsonValueKind.Array && array.EnumerateArray().All(e => e.ValueKind == JsonValueKind.Object
                    && e.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(name.GetString()));

            private static bool ValidRatings(JsonElement container, string mediaType)
            {
                if (container.ValueKind != JsonValueKind.Object || !container.TryGetProperty("results", out var rows) || rows.ValueKind != JsonValueKind.Array) return false;
                foreach (var row in rows.EnumerateArray())
                {
                    if (row.ValueKind != JsonValueKind.Object || !row.TryGetProperty("iso_3166_1", out var iso) || iso.ValueKind != JsonValueKind.String) return false;
                    if (mediaType == "tv")
                    {
                        if (!row.TryGetProperty("rating", out var rating) || rating.ValueKind != JsonValueKind.String) return false;
                    }
                    else if (!row.TryGetProperty("release_dates", out var dates) || dates.ValueKind != JsonValueKind.Array
                        || dates.EnumerateArray().Any(d => d.ValueKind != JsonValueKind.Object
                            || !d.TryGetProperty("certification", out var cert) || cert.ValueKind != JsonValueKind.String)) return false;
                }
                return true;
            }
        }

        // Preserve the existing Seerr-mode source preference: tiny TMDB certification lookup when possible,
        // otherwise full Seerr detail; tag rules use full Seerr detail. No JE caller can select this source.
        private sealed class Seerr(IHttpClientFactory http, TmdbResponseCache tmdb, string tmdbKey, string? urls, string? apiKey) : ITitleParentalEvidence
        {
            public string CacheScope { get; } = "seerr:" + Scope(tmdbKey, urls, apiKey);

            public async Task<TitleParentalEvidence?> ReadAsync(string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
            {
                if (!needTags && !string.IsNullOrWhiteSpace(tmdbKey))
                {
                    try
                    {
                        var response = await tmdb.GetAsync(mediaType + "/" + tmdbId.ToString(CultureInfo.InvariantCulture)
                            + (mediaType == "movie" ? "/release_dates" : "/content_ratings"), string.Empty, tmdbKey, ct).ConfigureAwait(false);
                        if (response.IsSuccess)
                        {
                            using var doc = JsonDocument.Parse(response.Content);
                            return FromSeerr(doc.RootElement, mediaType, region, false);
                        }
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception) { /* Preserve the existing Seerr-mode fallback after a failed certification read. */ }
                }
                if (string.IsNullOrWhiteSpace(urls) || string.IsNullOrWhiteSpace(apiKey)) return null;
                var client = SeerrHttpHelper.CreateClient(http);
                foreach (var url in urls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    // A captured old lookup cannot initiate Seerr transport after JE has been selected.
                    if (!SeerrMetadataMode(JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend)) return null;
                    try
                    {
                        var uri = url.Trim().TrimEnd('/') + "/api/v1/" + mediaType + "/" + tmdbId.ToString(CultureInfo.InvariantCulture);
                        using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, uri, apiKey);
                        using var response = await client.SendAsync(request, ct).ConfigureAwait(false);
                        var (body, error) = await SeerrHttpHelper.ReadResponseAsync(response, uri, ct).ConfigureAwait(false);
                        if (error != null || string.IsNullOrWhiteSpace(body)) continue;
                        using var doc = JsonDocument.Parse(body);
                        return FromSeerr(doc.RootElement, mediaType, region, SeerrTagSignatureExtractor.HasKeywordData(doc.RootElement));
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception) { /* Try the next configured Seerr address, as before. */ }
                }
                return null;
            }
        }

        internal static TitleParentalEvidence FromSeerr(JsonElement detail, string mediaType, string region, bool includeTags)
        {
            var cert = SeerrCertificationExtractor.Extract(detail, mediaType, region);
            var tags = SeerrTagSignatureExtractor.Extract(detail);
            return new(cert.Certification, cert.Iso ?? region, includeTags ? tags.Keywords.ToArray() : null,
                includeTags ? tags.Genres.ToArray() : null,
                detail.ValueKind == JsonValueKind.Object && detail.TryGetProperty("adult", out var adult)
                    && adult.ValueKind is JsonValueKind.True or JsonValueKind.False ? adult.GetBoolean() : null);
        }
    }
}
