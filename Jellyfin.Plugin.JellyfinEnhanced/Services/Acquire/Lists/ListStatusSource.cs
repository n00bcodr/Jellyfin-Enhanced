using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The caller's request status of list titles: the shared Requests &amp; downloads status (stage, reason, journey,
    /// dates, actions) exactly as the status service composes it for that viewer, so a list never has a status of its own.
    /// </summary>
    public interface IListStatusSource
    {
        /// <summary>Statuses by title key (as passed in); titles the viewer may not see are left out.</summary>
        /// <param name="user">The viewer.</param>
        /// <param name="keys">Title keys (movie or series).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Status JSON per key.</returns>
        Task<IReadOnlyDictionary<string, JsonElement>> StatusesAsync(Guid user, IReadOnlyList<TitleKey> keys, CancellationToken cancellationToken);

        /// <summary>
        /// Season-scoped statuses (a season or the listed episodes of one season), by <see cref="SeasonId"/>: the status a
        /// native season page shows, never the series card's (which reads Ready as soon as any season is in).
        /// </summary>
        /// <param name="user">The viewer.</param>
        /// <param name="seasons">(series key, TMDB id, season number).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Status JSON per <see cref="SeasonId"/>.</returns>
        Task<IReadOnlyDictionary<string, JsonElement>> SeasonStatusesAsync(Guid user, IReadOnlyList<(TitleKey Key, int TmdbId, int Season)> seasons, CancellationToken cancellationToken);

        /// <summary>
        /// Season-scoped statuses with what the list knows of each season's episodes (numbers and air dates), so a season
        /// no Sonarr holds is judged by its own episodes (out once one aired) rather than as not out yet.
        /// </summary>
        /// <param name="user">The viewer.</param>
        /// <param name="seasons">The seasons.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Status JSON per <see cref="ListStatusKeys.SeasonId"/>.</returns>
        Task<IReadOnlyDictionary<string, JsonElement>> SeasonStatusesAsync(Guid user, IReadOnlyList<ListStatusSeason> seasons, CancellationToken cancellationToken)
            => SeasonStatusesAsync(user, seasons.Select(s => (s.Key, s.TmdbId, s.Season)).ToList(), cancellationToken);

        /// <summary>
        /// Statuses of entries the title or season status can't stand for, by <see cref="ListStatusPart.Id"/>: a 4K entry
        /// follows the 4K copies alone (and the asks for them), never the standard copy Jellyfin may already have; an
        /// entry for some episodes follows exactly those episodes, never the rest of their season.
        /// </summary>
        /// <param name="user">The viewer.</param>
        /// <param name="parts">The entries' scopes.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Status JSON per part id.</returns>
        Task<IReadOnlyDictionary<string, JsonElement>> PartStatusesAsync(Guid user, IReadOnlyList<ListStatusPart> parts, CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyDictionary<string, JsonElement>>(new Dictionary<string, JsonElement>(StringComparer.Ordinal));
    }

    /// <summary>A season entry's season, with the episodes the list knows of it.</summary>
    /// <param name="Key">Series key.</param>
    /// <param name="TmdbId">TMDB id of the series.</param>
    /// <param name="Season">Season number.</param>
    /// <param name="Episodes">Its known episodes (number, air date), from the entry's episode list; empty when unknown.</param>
    /// <param name="Released">The season has premiered (by the entry's release date).</param>
    public sealed record ListStatusSeason(TitleKey Key, int TmdbId, int Season, IReadOnlyList<(int Episode, DateTime? AirDate)> Episodes, bool Released);

    /// <summary>The scope of a list entry whose status is its own (see <see cref="IListStatusSource.PartStatusesAsync"/>).</summary>
    /// <param name="Key">Movie or series key.</param>
    /// <param name="Season">The season (season entries), or null for the whole title or an episodes entry.</param>
    /// <param name="FourK">The 4K edition.</param>
    /// <param name="Episodes">The episodes (episodes entries), or null.</param>
    public sealed record ListStatusPart(TitleKey Key, int? Season, bool FourK, IReadOnlyList<(int Season, int Episode)>? Episodes = null)
    {
        /// <summary>The part's status id (<see cref="ListStatusKeys.PartId"/>).</summary>
        public string Id => ListStatusKeys.PartId(this);
    }

    /// <summary>Keys of season-scoped statuses.</summary>
    public static class ListStatusKeys
    {
        /// <summary>The id of a season's status: <c>{series key}:s{n}</c>.</summary>
        /// <param name="key">Series key.</param>
        /// <param name="season">Season.</param>
        /// <returns>The id.</returns>
        public static string SeasonId(TitleKey key, int season) => key.WithSeason(season).ToString();

        /// <summary>
        /// The id of a part's status: the title or season id, or for episodes each season's key with its episodes
        /// (<c>tv:tvdb:1:s2:e1,3</c>, in order); then <c>@4k</c> for the 4K edition.
        /// </summary>
        /// <param name="part">The part.</param>
        /// <returns>The id.</returns>
        public static string PartId(ListStatusPart part)
        {
            var id = part.Episodes is { Count: > 0 } episodes
                ? string.Join("+", episodes.Distinct().GroupBy(e => e.Season).OrderBy(g => g.Key).Select(g =>
                    part.Key.WithSeason(g.Key).ToString() + ":e" + string.Join(",", g.Select(e => e.Episode).OrderBy(n => n).Select(n => n.ToString(CultureInfo.InvariantCulture)))))
                : part.Season is int season ? SeasonId(part.Key, season) : part.Key.ToString();
            return id + (part.FourK ? "@" + ListRules.FourK : string.Empty);
        }
    }

    /// <summary><see cref="IListStatusSource"/> over <see cref="ArrStatusService"/> (batches of its key limit).</summary>
    public sealed class ArrListStatusSource : IListStatusSource
    {
        /// <summary>Most titles whose status one list view reads.</summary>
        public const int MaxTitles = 300;

        /// <summary>Most season-scoped statuses one list view reads.</summary>
        public const int MaxSeasons = 60;

        private readonly ArrStatusService _status;
        private readonly IArrJellyfinView _view;
        private readonly TitleAliases? _aliases;

        /// <summary>Creates the source (DI).</summary>
        /// <param name="status">Status service.</param>
        /// <param name="view">Jellyfin view (the viewer's policy).</param>
        /// <param name="aliases">Title aliases (a status keyed by another id of the same title still matches).</param>
        public ArrListStatusSource(ArrStatusService status, IArrJellyfinView view, TitleAliases? aliases = null)
        {
            _status = status;
            _view = view;
            _aliases = aliases;
        }

        /// <inheritdoc />
        public async Task<IReadOnlyDictionary<string, JsonElement>> StatusesAsync(Guid user, IReadOnlyList<TitleKey> keys, CancellationToken cancellationToken)
        {
            using var publication = SeerrFacts.BeginPublication();
            var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (!_status.Enabled || keys.Count == 0)
            {
                return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
            }

            var viewer = _view.Viewer(user);
            if (viewer == null)
            {
                return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
            }

            var wanted = keys.Distinct().Take(MaxTitles).ToList();
            using var scope = _status.Store.BeginRequest("acquire/lists");
            for (var i = 0; i < wanted.Count; i += ArrStatusService.MaxKeys)
            {
                var batch = wanted.Skip(i).Take(ArrStatusService.MaxKeys).ToList();
                var body = await _status.ForBatchAsync(viewer, Array.Empty<Guid>(), batch, cancellationToken).ConfigureAwait(false);
                using var json = JsonDocument.Parse(body.Json);
                if (!json.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                var byCanonical = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var item in items.EnumerateArray())
                {
                    foreach (var name in new[] { "key", "liveKey" })
                    {
                        if (item.TryGetProperty(name, out var k) && k.ValueKind == JsonValueKind.String && TitleKey.Parse(k.GetString()) is { } parsed)
                        {
                            byCanonical.TryAdd(Canonical(parsed), item.Clone());
                        }
                    }
                }

                foreach (var key in batch)
                {
                    if (byCanonical.TryGetValue(Canonical(key), out var status))
                    {
                        result[key.ToString()] = status;
                    }
                }
            }

            return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
        }

        /// <inheritdoc />
        public Task<IReadOnlyDictionary<string, JsonElement>> SeasonStatusesAsync(Guid user, IReadOnlyList<(TitleKey Key, int TmdbId, int Season)> seasons, CancellationToken cancellationToken)
            => SeasonStatusesAsync(user, seasons.Select(s => new ListStatusSeason(s.Key, s.TmdbId, s.Season, Array.Empty<(int, DateTime?)>(), false)).ToList(), cancellationToken);

        /// <inheritdoc />
        public async Task<IReadOnlyDictionary<string, JsonElement>> SeasonStatusesAsync(Guid user, IReadOnlyList<ListStatusSeason> seasons, CancellationToken cancellationToken)
        {
            using var publication = SeerrFacts.BeginPublication();
            var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (!_status.Enabled || seasons.Count == 0)
            {
                return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
            }

            var viewer = _view.Viewer(user);
            if (viewer == null)
            {
                return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
            }

            using var scope = _status.Store.BeginRequest("acquire/lists");
            foreach (var entry in seasons.DistinctBy(s => ListStatusKeys.SeasonId(s.Key, s.Season)).Take(MaxSeasons))
            {
                var id = ListStatusKeys.SeasonId(entry.Key, entry.Season);
                // A virtual page for the season (its id never stands for a file), composed like a native season page, with
                // the episodes the list knows (a season no Sonarr holds is judged by them).
                var episodes = entry.Episodes.DistinctBy(e => e.Episode).OrderBy(e => e.Episode)
                    .Select(e => new AbsentEpisode(entry.Season, e.Episode, e.AirDate, PageId(id + ":e" + e.Episode.ToString(CultureInfo.InvariantCulture))))
                    .ToList();
                var page = new AbsentTitle { PageId = PageId(id), Kind = "season", Title = entry.Key, TmdbId = entry.TmdbId, Season = entry.Season, Episodes = episodes };
                var body = await _status.ForAbsentAsync(viewer, page, cancellationToken).ConfigureAwait(false);
                using var json = JsonDocument.Parse(body.Json);
                if (json.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array && items.GetArrayLength() > 0)
                {
                    var status = items[0];
                    // Premiered, but none of its episodes known (and no Sonarr to say): unknown, never "not out yet".
                    if (episodes.Count == 0 && entry.Released && status.TryGetProperty("stage", out var stage) && stage.GetString() == "notOut")
                    {
                        continue;
                    }

                    result[id] = status.Clone();
                }
            }

            return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
        }

        /// <inheritdoc />
        public async Task<IReadOnlyDictionary<string, JsonElement>> PartStatusesAsync(Guid user, IReadOnlyList<ListStatusPart> parts, CancellationToken cancellationToken)
        {
            using var publication = SeerrFacts.BeginPublication();
            var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (!_status.Enabled || parts.Count == 0)
            {
                return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
            }

            var viewer = _view.Viewer(user);
            if (viewer == null)
            {
                return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
            }

            using var scope = _status.Store.BeginRequest("acquire/lists");
            foreach (var part in parts.DistinctBy(p => p.Id).Take(MaxSeasons))
            {
                var seasons = part.Season is int season ? new[] { season } : Array.Empty<int>();
                var body = await _status.ForPartAsync(viewer, part.Key, seasons, part.Episodes ?? Array.Empty<(int Season, int Episode)>(), part.FourK, cancellationToken).ConfigureAwait(false);
                using var json = JsonDocument.Parse(body.Json);
                if (json.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array && items.GetArrayLength() > 0)
                {
                    result[part.Id] = items[0].Clone();
                }
            }

            return publication.Publish<IReadOnlyDictionary<string, JsonElement>>(() => result);
        }

        // A stable id for a list season's virtual page (the status cache keys on it).
        private static Guid PageId(string id) =>
            new(System.Security.Cryptography.MD5.HashData(System.Text.Encoding.UTF8.GetBytes("je-list-season|" + id)));

        private string Canonical(TitleKey key) => (_aliases?.Canonical(key) ?? key).ToString();
    }
}
