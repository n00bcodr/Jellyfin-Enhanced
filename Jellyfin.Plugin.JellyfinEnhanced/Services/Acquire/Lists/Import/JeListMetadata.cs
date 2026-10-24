using System;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// The list core's metadata (<see cref="IListMetadataSource"/>) read from TMDB with Jellyfin Enhanced's own key, for
    /// JE households (enabled with lists by <see cref="ListImportFlags.JeMetadata"/>). It reads the same three
    /// resources the Seerr reader does (<c>movie/{id}</c>, <c>tv/{id}</c> with external ids, <c>tv/{id}/season/{n}</c>)
    /// through the shared <see cref="TmdbResponseCache"/> and turns them into <see cref="PlaceholderMetadata"/> with the
    /// list core's own transformations (<see cref="ListMetadataService.FromMovie"/>/<see cref="ListMetadataService.FromTv"/>,
    /// fed TMDB's answer in Seerr's field names), so release dates, expected episodes, production state and partial
    /// seasons mean exactly what they mean with Seerr. Answers are public TMDB data shared by every viewer; the per-viewer
    /// projection (parental limits, Spoiler Guard) stays with the list views. Null always means unknown. Review round 7: each
    /// answer is read by the same contract as Seerr's (<see cref="ResponseContract.MetadataMovie"/>, <c>MetadataShow</c>,
    /// <c>MetadataSeason</c>): a Malformed one is unknown, a Partial one is used as partial metadata (never clears a value),
    /// and neither stays in TMDB's response cache.
    /// </summary>
    public sealed class TmdbListMetadataSource
    {
        private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(6);
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

        private readonly TmdbResponseCache _tmdb;
        private readonly Logger _logger;

        /// <summary>Creates the reader (DI).</summary>
        /// <param name="tmdb">JE's TMDB response cache.</param>
        /// <param name="logger">JE logger.</param>
        public TmdbListMetadataSource(TmdbResponseCache tmdb, Logger logger)
        {
            _tmdb = tmdb;
            _logger = logger;
        }

        private static string Key => JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey()?.Trim() ?? string.Empty;

        /// <summary>True when the JE-only path is on and a TMDB key is saved.</summary>
        public static bool IsAvailable => ListImportFlags.JeMetadata(JellyfinEnhanced.Instance?.Configuration) && Key.Length > 0;

        /// <summary>The metadata an entry needs, from TMDB; null when unknown or unavailable.</summary>
        /// <param name="placeholder">Entry.</param>
        /// <param name="maxAge">Answers older than this are read again (below TMDB cache's 6 h lifetime: always fresh).</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Metadata or null.</returns>
        public async Task<PlaceholderMetadata?> FetchAsync(Placeholder placeholder, TimeSpan maxAge, DateTime todayUtc, CancellationToken cancellationToken)
        {
            if (placeholder.Kind == PlaceholderKinds.Custom || placeholder.TmdbId is not > 0 || !IsAvailable)
            {
                return null;
            }

            var fresh = maxAge < CacheLifetime;
            var id = placeholder.TmdbId.Value.ToString(CultureInfo.InvariantCulture);
            var epoch = ListMetadataEpoch.Capture();
            if (placeholder.Kind == PlaceholderKinds.Movie)
            {
                var movie = await ListContinuation.Await(() => GetAsync("movie/" + id, "?append_to_response=external_ids", ResponseContract.MetadataMovie, new AnswerRequest(placeholder.TmdbId, "movie"), fresh, cancellationToken)).ConfigureAwait(false);
                return movie == null ? null : Admit(ListMetadataService.FromMovie(movie.Value.Read, movie.Value.FetchedAtUtc));
            }

            var tv = await ListContinuation.Await(() => GetAsync("tv/" + id, "?append_to_response=external_ids", ResponseContract.MetadataShow, new AnswerRequest(placeholder.TmdbId, "tv"), fresh, cancellationToken)).ConfigureAwait(false);
            if (tv == null)
            {
                return null;
            }

            (ContractRead Read, DateTime FetchedAtUtc)? season = null;
            if (placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && placeholder.SeasonNumber is int number)
            {
                // A season read that fails leaves season null: FromTv then marks the answer partial (it never shrinks the
                // expected set from the show's details alone).
                season = await ListContinuation.Await(() => GetAsync("tv/" + id + "/season/" + number.ToString(CultureInfo.InvariantCulture), string.Empty, ResponseContract.MetadataSeason, new AnswerRequest(Season: number, Show: placeholder.TmdbId), fresh, cancellationToken)).ConfigureAwait(false);
            }

            var fetchedAt = tv.Value.FetchedAtUtc < (season?.FetchedAtUtc ?? DateTime.MaxValue) ? tv.Value.FetchedAtUtc : season!.Value.FetchedAtUtc;
            return Admit(ListMetadataService.FromTv(placeholder, tv.Value.Read, season?.Read, fetchedAt, todayUtc));

            PlaceholderMetadata? Admit(PlaceholderMetadata metadata)
            {
                metadata.ReadEpoch = epoch;
                return epoch.IsCurrent ? metadata : null;
            }
        }

        // One TMDB resource in Seerr's field names (camelCase) as `schema` reads it against the request (its verdict and typed
        // values), or null (not found, an error, a Malformed answer: another title's or season's included). An answer that isn't Valid is dropped from TMDB's response cache (asked again
        // next time).
        private async Task<(ContractRead Read, DateTime FetchedAtUtc)?> GetAsync(string path, string query, ResourceSchema schema, AnswerRequest asked, bool fresh, CancellationToken cancellationToken)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(Timeout);
                var response = await _tmdb.GetAsync(path, query, Key, timeout.Token, refresh: fresh).ConfigureAwait(false);
                if (!response.IsSuccess)
                {
                    return null;
                }

                using var doc = JsonDocument.Parse(response.Content);
                var root = doc.RootElement.ValueKind == JsonValueKind.Object ? Camelize(doc.RootElement) : doc.RootElement;
                var read = schema.Validate(asked, root); // the title, show or season asked for (review round 9)
                if (read.Verdict != ResponseVerdict.Valid)
                {
                    _tmdb.Forget(path, query, Key);
                    _logger.Debug($"[Lists] TMDB metadata {path} answered {(read.Verdict == ResponseVerdict.Partial ? "in part" : "something JE can't read")} ({read.Reason})");
                }

                return read.Verdict == ResponseVerdict.Malformed ? null : (read, response.FetchedAtUtc);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger.Debug($"[Lists] TMDB metadata {path} failed: {UpstreamDiagnostics.Code(ex)}");
                return null;
            }
        }

        /// <summary>
        /// TMDB's answer with Seerr's field names: every <c>snake_case</c> property becomes <c>camelCase</c>
        /// (<c>release_date</c> → <c>releaseDate</c>, <c>external_ids.tvdb_id</c> → <c>externalIds.tvdbId</c>); values stay.
        /// </summary>
        /// <param name="element">TMDB JSON.</param>
        /// <returns>The same JSON in camelCase.</returns>
        internal static JsonElement Camelize(JsonElement element)
        {
            var buffer = new System.IO.MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                Write(writer, element, 0);
            }

            using var doc = JsonDocument.Parse(buffer.ToArray());
            return doc.RootElement.Clone();

            static void Write(Utf8JsonWriter writer, JsonElement value, int depth)
            {
                if (depth > 32)
                {
                    writer.WriteNullValue();
                    return;
                }

                switch (value.ValueKind)
                {
                    case JsonValueKind.Object:
                        writer.WriteStartObject();
                        foreach (var property in value.EnumerateObject())
                        {
                            writer.WritePropertyName(CamelCase(property.Name));
                            Write(writer, property.Value, depth + 1);
                        }

                        writer.WriteEndObject();
                        break;
                    case JsonValueKind.Array:
                        writer.WriteStartArray();
                        foreach (var item in value.EnumerateArray())
                        {
                            Write(writer, item, depth + 1);
                        }

                        writer.WriteEndArray();
                        break;
                    default:
                        value.WriteTo(writer);
                        break;
                }
            }
        }

        private static string CamelCase(string name)
        {
            if (name.IndexOf('_', StringComparison.Ordinal) < 0)
            {
                return name;
            }

            var builder = new StringBuilder(name.Length);
            var upper = false;
            foreach (var c in name)
            {
                if (c == '_')
                {
                    upper = builder.Length > 0;
                    continue;
                }

                builder.Append(upper ? char.ToUpperInvariant(c) : c);
                upper = false;
            }

            return builder.ToString();
        }
    }

    /// <summary>
    /// The list core's metadata source as registered (the 4c1 seam, <see cref="IListMetadataSource"/>): Seerr exactly as
    /// before in Seerr mode whenever Seerr is set up; JE mode always selects
    /// TMDB (<see cref="TmdbListMetadataSource"/>), enabled with lists and a saved TMDB key. With neither, metadata is unavailable (custom entries and exact source
    /// metadata still work; nothing is invented). Posters keep coming from the existing reader (JE's TMDB key).
    /// </summary>
    public sealed class ListMetadataSources : IListMetadataSource
    {
        private readonly ListMetadataService _seerr;
        private readonly TmdbListMetadataSource _tmdb;

        /// <summary>Creates the source (DI).</summary>
        /// <param name="seerr">The Seerr reader (also the poster reader).</param>
        /// <param name="tmdb">The TMDB reader.</param>
        public ListMetadataSources(ListMetadataService seerr, TmdbListMetadataSource tmdb)
        {
            _seerr = seerr;
            _tmdb = tmdb;
        }

        private static bool SeerrFirst => ListMetadataService.IsAvailable;

        /// <inheritdoc />
        public bool Available => SeerrFirst || TmdbListMetadataSource.IsAvailable;

        /// <inheritdoc />
        public bool PostersAvailable => ((IListMetadataSource)_seerr).PostersAvailable;

        /// <inheritdoc />
        public Task<PlaceholderMetadata?> FetchAsync(Placeholder placeholder, TimeSpan maxAge, DateTime todayUtc, CancellationToken cancellationToken) =>
            SeerrFirst ? _seerr.FetchAsync(placeholder, maxAge, todayUtc, cancellationToken) : _tmdb.FetchAsync(placeholder, maxAge, todayUtc, cancellationToken);

        /// <inheritdoc />
        public Task<string?> FetchTmdbPosterAsync(Placeholder placeholder, CancellationToken cancellationToken) => _seerr.FetchTmdbPosterAsync(placeholder, cancellationToken);

        /// <inheritdoc />
        public Task<(string? Poster, bool Answered)> ReadTmdbPosterAsync(Placeholder placeholder, CancellationToken cancellationToken) => _seerr.ReadTmdbPosterAsync(placeholder, cancellationToken);
    }
}
