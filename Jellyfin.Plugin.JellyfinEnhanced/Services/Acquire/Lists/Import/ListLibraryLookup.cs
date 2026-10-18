using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// What to look for in the library (one import entry at its granularity). The title is named only by its
    /// <see cref="CompletedIdentity"/> (review round 3, D53 rule 2), so "in library" is asked under every id it is known by.
    /// </summary>
    /// <param name="Kind">movie | series | season | episodes.</param>
    /// <param name="Identity">The title's completed identity (movie, or the series for TV scopes).</param>
    /// <param name="Season">Season (season / episodes scopes).</param>
    /// <param name="Episodes">Episode numbers of that season (episodes scope).</param>
    public sealed record LibraryScope(string Kind, CompletedIdentity Identity, int? Season, IReadOnlyList<int>? Episodes)
    {
        /// <summary>TMDB id (0 when unknown).</summary>
        public int TmdbId => Identity.Tmdb ?? 0;

        /// <summary>TVDB id of the series, if known.</summary>
        public int? TvdbId => Identity.Tvdb;

        /// <summary>IMDb id of the movie / series, if known.</summary>
        public string? ImdbId => Identity.Imdb;
    }

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

        /// <summary>
        /// The list-source keys a library item stands for (no access check: it only says what an item already in a list
        /// is). Movie: <c>movie|tmdb||</c>, <c>imdb|tt…||</c>; episode: <c>tv|show|s|e</c> (each episode of a
        /// multi-episode file), <c>tvdb|show|s|e</c>; season: <c>tv|show|s|</c>; series: <c>tv|show||</c>.
        /// </summary>
        /// <param name="itemId">Library item.</param>
        /// <returns>Keys (empty when unknown).</returns>
        IReadOnlyList<string> SourceKeysOf(Guid itemId) => Array.Empty<string>();
    }

    /// <summary>
    /// <see cref="IListLibraryLookup"/> over <see cref="ListResolver"/> (design C1), the same matching the
    /// apply and swap-in use: movies by TMDB then IMDb id; TV by the SERIES' TMDB / TVDB / IMDb ids, episodes by
    /// season/episode number (a multi-episode file covers each number; virtual items never count; one item per
    /// coordinate across library copies). The query is scoped to the first user and every other user must be able to
    /// access each returned item.
    /// </summary>
    public sealed class ResolverListLibraryLookup : IListLibraryLookup
    {
        private readonly ListResolver _resolver;
        private readonly IListHost _host;

        /// <summary>Creates the lookup.</summary>
        /// <param name="resolver">The granularity resolver.</param>
        /// <param name="host">Jellyfin seam (item facts for <see cref="SourceKeysOf"/>).</param>
        public ResolverListLibraryLookup(ListResolver resolver, IListHost host)
        {
            _resolver = resolver;
            _host = host;
        }

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

        /// <inheritdoc />
        public IReadOnlyList<string> SourceKeysOf(Guid itemId)
        {
            var facts = _host.GetItemFacts(itemId);
            var keys = new List<string>();
            if (facts == null)
            {
                return keys;
            }

            void Add(string provider, IReadOnlyDictionary<string, string>? ids, string idName, string season, string episode)
            {
                if (ids != null && ids.TryGetValue(idName, out var id) && !string.IsNullOrEmpty(id))
                {
                    var key = provider + "|" + id + "|" + season + "|" + episode;
                    if (Sources.SourceKeys.IsValid(key))
                    {
                        keys.Add(key);
                    }
                }
            }

            var tmdb = MetadataProvider.Tmdb.ToString();
            var tvdb = MetadataProvider.Tvdb.ToString();
            var imdb = MetadataProvider.Imdb.ToString();
            switch (facts.Kind)
            {
                case BaseItemKind.Movie:
                    Add("movie", facts.ProviderIds, tmdb, string.Empty, string.Empty);
                    Add("imdb", facts.ProviderIds, imdb, string.Empty, string.Empty);
                    break;
                case BaseItemKind.Episode when facts.Season is int season && facts.Episode is int first:
                {
                    // Each episode of a multi-episode file (capped like the resolver's coordinates).
                    var last = facts.EpisodeEnd is int end && end >= first ? Math.Min(end, first + 99) : first;
                    var s = season.ToString(CultureInfo.InvariantCulture);
                    for (var number = first; number <= last; number++)
                    {
                        var e = number.ToString(CultureInfo.InvariantCulture);
                        Add("tv", facts.SeriesProviderIds, tmdb, s, e);
                        Add("tvdb", facts.SeriesProviderIds, tvdb, s, e);
                    }

                    break;
                }

                case BaseItemKind.Season when facts.Season is int number:
                    var seasonNumber = number.ToString(CultureInfo.InvariantCulture);
                    Add("tv", facts.SeriesProviderIds, tmdb, seasonNumber, string.Empty);
                    Add("tvdb", facts.SeriesProviderIds, tvdb, seasonNumber, string.Empty);
                    break;
                case BaseItemKind.Series:
                    Add("tv", facts.ProviderIds, tmdb, string.Empty, string.Empty);
                    Add("tvdb", facts.ProviderIds, tvdb, string.Empty, string.Empty);
                    Add("imdb", facts.ProviderIds, imdb, string.Empty, string.Empty);
                    break;
            }

            return keys;
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
