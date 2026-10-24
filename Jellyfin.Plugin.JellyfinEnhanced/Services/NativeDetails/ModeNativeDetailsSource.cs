using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// The native details source the request mode picks, read on every call so a mode change needs no
    /// restart (Requests &amp; downloads, A1): the Jellyfin Enhanced backend (<see cref="NativeDetailsPolicy.JeBackend"/>,
    /// with or without the rollout switches and whatever Seerr settings remain) reads TMDB (<see cref="TmdbNativeDetailsSource"/>) and never Seerr;
    /// every other mode keeps Seerr (<see cref="SeerrNativeDetailsSource"/>) exactly as before. Every member
    /// is forwarded, the interface's defaults included.
    /// </summary>
    public sealed class ModeNativeDetailsSource : INativeDetailsSource
    {
        private readonly INativeDetailsSource _seerr;
        private readonly INativeDetailsSource _tmdb;
        private readonly Func<bool> _jeMode;

        /// <summary>Creates the router over the configured request mode.</summary>
        /// <param name="seerr">Seerr's source.</param>
        /// <param name="tmdb">TMDB's source.</param>
        public ModeNativeDetailsSource(SeerrNativeDetailsSource seerr, TmdbNativeDetailsSource tmdb)
            : this(seerr, tmdb, () => JellyfinEnhanced.Instance?.Configuration is { } c && NativeDetailsPolicy.JeBackend(c))
        {
        }

        /// <summary>Creates the router with its own mode test (tests).</summary>
        internal ModeNativeDetailsSource(INativeDetailsSource seerr, INativeDetailsSource tmdb, Func<bool> jeMode)
        {
            _seerr = seerr;
            _tmdb = tmdb;
            _jeMode = jeMode;
        }

        /// <summary>The source of the request mode in effect now.</summary>
        internal INativeDetailsSource Current => _jeMode() ? _tmdb : _seerr;

        /// <inheritdoc />
        public Task<SourceAnswer> MovieAsync(int tmdb, CancellationToken ct) => Current.MovieAsync(tmdb, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeriesAsync(int tmdb, CancellationToken ct) => Current.SeriesAsync(tmdb, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, CancellationToken ct) => Current.SeasonAsync(tmdb, season, ct);

        /// <inheritdoc />
        public Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, CancellationToken ct) => Current.RecommendationsAsync(movie, tmdb, ct);

        /// <inheritdoc />
        public Task<string?> LogoPathAsync(bool movie, int tmdb, CancellationToken ct) => Current.LogoPathAsync(movie, tmdb, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonAsync(int tmdb, CancellationToken ct) => Current.PersonAsync(tmdb, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> GenresAsync(bool movie, CancellationToken ct) => Current.GenresAsync(movie, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> StudioAsync(int tmdb, CancellationToken ct) => Current.StudioAsync(tmdb, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> NetworkAsync(int tmdb, CancellationToken ct) => Current.NetworkAsync(tmdb, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonCreditsAsync(int tmdb, Guid viewer, CancellationToken ct) => Current.PersonCreditsAsync(tmdb, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> DiscoverAsync(bool movie, string filter, int id, int page, string? sortBy, Guid viewer, CancellationToken ct)
            => Current.DiscoverAsync(movie, filter, id, page, sortBy, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> CompanySeriesAsync(int company, int page, string? sortBy, Guid viewer, CancellationToken ct)
            => Current.CompanySeriesAsync(company, page, sortBy, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> MovieAsync(int tmdb, Guid viewer, CancellationToken ct) => Current.MovieAsync(tmdb, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeriesAsync(int tmdb, Guid viewer, CancellationToken ct) => Current.SeriesAsync(tmdb, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, Guid viewer, CancellationToken ct) => Current.SeasonAsync(tmdb, season, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonAsync(int tmdb, Guid viewer, CancellationToken ct) => Current.PersonAsync(tmdb, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> StudioAsync(int tmdb, Guid viewer, CancellationToken ct) => Current.StudioAsync(tmdb, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> NetworkAsync(int tmdb, Guid viewer, CancellationToken ct) => Current.NetworkAsync(tmdb, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> RatingsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct) => Current.RatingsAsync(movie, tmdb, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> RelatedAsync(bool movie, int tmdb, string relation, int page, Guid viewer, CancellationToken ct)
            => Current.RelatedAsync(movie, tmdb, relation, page, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> CollectionAsync(int collection, Guid viewer, CancellationToken ct) => Current.CollectionAsync(collection, viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> KeywordsAsync(string query, Guid viewer, CancellationToken ct) => Current.KeywordsAsync(query, viewer, ct);

        /// <inheritdoc />
        public Task<bool?> IsSeerrLinkedAsync(Guid userId, CancellationToken ct) => Current.IsSeerrLinkedAsync(userId, ct);
    }
}
