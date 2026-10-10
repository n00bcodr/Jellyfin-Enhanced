using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import
{
    /// <summary>What to look for in the library (one import entry at its granularity).</summary>
    /// <param name="Kind">movie | series | season | episodes.</param>
    /// <param name="TmdbId">TMDB id (movie, or the series for TV scopes).</param>
    /// <param name="TvdbId">TVDB id of the series, if known.</param>
    /// <param name="ImdbId">IMDb id of the movie / series, if known.</param>
    /// <param name="Season">Season (season / episodes scopes).</param>
    /// <param name="Episodes">Episode numbers of that season (episodes scope).</param>
    public sealed record LibraryScope(string Kind, int TmdbId, int? TvdbId, string? ImdbId, int? Season, IReadOnlyList<int>? Episodes);

    /// <summary>A library match for a scope, as seen by every given user.</summary>
    /// <param name="ItemId">
    /// Movie / Series item; for a season its Season item (the first episode when no Season item can be added yet); for
    /// an episodes scope the first found episode.
    /// </param>
    /// <param name="Kind">The scope kind.</param>
    /// <param name="EpisodeIds">Episode items in season/episode order (TV scopes; what a playlist would get).</param>
    /// <param name="Complete">Whether everything the scope names is present (series/season: at least <c>expected</c> episodes; episodes: every listed one).</param>
    public sealed record LibraryMatch(Guid ItemId, string Kind, IReadOnlyList<Guid> EpisodeIds, bool Complete);

    /// <summary>
    /// The library side of an import entry ("already in your library?"): <c>Find(scope, users, expectedEpisodes)</c> =
    /// "visible library items for this movie / series / season / episode set, plus whether the scope is complete".
    /// Production: <see cref="ResolverListLibraryLookup"/> over the granularity resolver (C1), so /resolve reports what
    /// the apply will really insert.
    /// </summary>
    public interface IListLibraryLookup
    {
        /// <summary>Finds the scope in the library; every user must be able to access the returned items.</summary>
        /// <param name="scope">What to look for.</param>
        /// <param name="users">Users that must all see it (the caller; for a playlist also its owner).</param>
        /// <param name="expectedEpisodes">Series/season: how many episodes make it complete (TMDB count), if known.</param>
        /// <returns>The match or null.</returns>
        LibraryMatch? Find(LibraryScope scope, IReadOnlyList<User> users, int? expectedEpisodes);
    }

    /// <summary>
    /// <see cref="IListLibraryLookup"/> over <see cref="ListPlaceholderResolver"/> (design C1), the same matching the
    /// apply and swap-in use: movies by TMDB then IMDb id; TV by the SERIES' TMDB / TVDB / IMDb ids, episodes by
    /// season/episode number (a multi-episode file covers each number; virtual items never count; one item per
    /// coordinate across library copies). The query is scoped to the first user and every other user must be able to
    /// access each returned item.
    /// </summary>
    public sealed class ResolverListLibraryLookup : IListLibraryLookup
    {
        private readonly ListPlaceholderResolver _resolver;

        /// <summary>Creates the lookup.</summary>
        /// <param name="resolver">The granularity resolver.</param>
        public ResolverListLibraryLookup(ListPlaceholderResolver resolver) => _resolver = resolver;

        /// <inheritdoc />
        public LibraryMatch? Find(LibraryScope scope, IReadOnlyList<User> users, int? expectedEpisodes)
        {
            ArgumentNullException.ThrowIfNull(scope);
            if (users.Count == 0 || scope.TmdbId <= 0)
            {
                return null;
            }

            var placeholder = ToPlaceholder(scope);
            if (placeholder == null)
            {
                return null;
            }

            if (scope.Kind == PlaceholderKinds.Movie)
            {
                var movie = _resolver.Resolve(placeholder, ListKinds.Playlist, users);
                return movie.Found ? new LibraryMatch(movie.Items[0].ItemId, scope.Kind, Array.Empty<Guid>(), true) : null;
            }

            // What a playlist gets: the present in-scope episodes in order (series: specials excluded).
            var episodes = _resolver.Resolve(placeholder, ListKinds.Playlist, users).Episodes;
            var episodeIds = episodes.Select(e => e.ItemId).ToList();
            var covered = episodes.SelectMany(e => e.Coords).Distinct().Count();
            switch (scope.Kind)
            {
                case PlaceholderKinds.Series:
                {
                    // A collection gets the Series item itself, even before any episode is there.
                    var series = _resolver.Resolve(placeholder, ListKinds.Collection, users);
                    return series.Found
                        ? new LibraryMatch(series.Items[0].ItemId, scope.Kind, episodeIds, expectedEpisodes is > 0 && covered >= expectedEpisodes.Value)
                        : null;
                }

                case PlaceholderKinds.Season:
                {
                    if (episodes.Count == 0)
                    {
                        return null; // a Season item without real episodes isn't "in the library"
                    }

                    var seasonItems = _resolver.Resolve(placeholder, ListKinds.Collection, users).Items;
                    var itemId = seasonItems.Count > 0 ? seasonItems[0].ItemId : episodes[0].ItemId;
                    return new LibraryMatch(itemId, scope.Kind, episodeIds, expectedEpisodes is > 0 && covered >= expectedEpisodes.Value);
                }

                default:
                {
                    if (episodes.Count == 0)
                    {
                        return null;
                    }

                    var wanted = placeholder.Episodes.Select(e => new EpisodeCoord(e.S, e.E)).ToHashSet();
                    var found = episodes.SelectMany(e => e.Coords).ToHashSet();
                    return new LibraryMatch(episodes[0].ItemId, scope.Kind, episodeIds, wanted.All(found.Contains));
                }
            }
        }

        // The scope as the resolver's input (only the fields it matches on); null when the scope is incomplete.
        private static Placeholder? ToPlaceholder(LibraryScope scope)
        {
            var placeholder = new Placeholder
            {
                Kind = scope.Kind,
                MediaType = scope.Kind == PlaceholderKinds.Movie ? "movie" : "tv",
                TmdbId = scope.TmdbId,
                TvdbId = scope.Kind == PlaceholderKinds.Movie ? null : scope.TvdbId,
                ImdbId = scope.ImdbId,
            };
            switch (scope.Kind)
            {
                case PlaceholderKinds.Movie:
                case PlaceholderKinds.Series:
                    return placeholder;
                case PlaceholderKinds.Season when scope.Season is >= 0:
                    placeholder.SeasonNumber = scope.Season;
                    return placeholder;
                case PlaceholderKinds.Episodes when scope.Season is >= 0 && scope.Episodes is { Count: > 0 }:
                    placeholder.SeasonNumber = scope.Season;
                    placeholder.Episodes = scope.Episodes.Distinct().OrderBy(e => e).Select(e => new PlaceholderEpisode { S = scope.Season.Value, E = e }).ToList();
                    return placeholder;
                default:
                    return null;
            }
        }
    }
}
