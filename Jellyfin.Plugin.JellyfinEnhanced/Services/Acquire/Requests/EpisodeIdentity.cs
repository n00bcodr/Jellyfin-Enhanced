using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One asked episode, in TMDB's numbering, and the Sonarr episode it is (same TVDB episode id).</summary>
    /// <param name="From">The episode as asked (TMDB's season and number).</param>
    /// <param name="To">The same episode as the request target's Sonarr numbers it.</param>
    public sealed record EpisodeRenumbering(RequestEpisode From, RequestEpisode To);

    /// <summary>What TMDB lists as an episode's TVDB id.</summary>
    /// <param name="Read">TMDB answered (false: it couldn't be asked now; nothing is concluded).</param>
    /// <param name="TvdbId">The TVDB episode id TMDB lists for it; null when TMDB answered and lists none.</param>
    public readonly record struct EpisodeExternalId(bool Read, int? TvdbId)
    {
        /// <summary>TMDB couldn't be asked now.</summary>
        public static EpisodeExternalId Unread => new(false, null);

        /// <summary>TMDB answered and lists no TVDB id (or doesn't know the episode).</summary>
        public static EpisodeExternalId None => new(true, null);
    }

    /// <summary>
    /// Episode identity across TMDB and Sonarr (F83). An ask made while no Sonarr held the series names episodes by TMDB's
    /// numbering, and Sonarr numbers a series as TVDB does: the two can name different episodes with the same S01E01. Such an
    /// ask (<see cref="MutationInput.Numbering"/> <see cref="Tmdb"/>) is matched, once the series is in the target's Sonarr,
    /// episode by episode by ids only: the TMDB episode, its TVDB episode id (TMDB's external ids for it), the Sonarr episode
    /// with that <c>tvdbId</c>. Names, air dates and positions are never compared: an episode that can't be matched by id is
    /// held for an administrator (<see cref="Unresolved"/>), never sent as a guess.
    /// </summary>
    public static class EpisodeIdentity
    {
        /// <summary>The numbering of an ask made by TMDB's episode numbers (<see cref="MutationInput.Numbering"/>).</summary>
        public const string Tmdb = "tmdb";

        /// <summary>A held request: an asked episode has no Sonarr episode with its TVDB id (or TMDB lists none for it).</summary>
        public const string Unresolved = "episode_identity_unresolved";

        /// <summary>Waiting once, a short while, for Sonarr's episode list to catch up before the request is held.</summary>
        public const string Pending = "episode_identity_pending";

        /// <summary>How long a request waits for Sonarr's episode list to catch up (<see cref="Pending"/>) before it is held.</summary>
        public static readonly TimeSpan PendingWait = TimeSpan.FromMinutes(2);

        /// <summary>
        /// TMDB's external ids of one episode through the shared TMDB cache (public facts, kept with the cache's own lifetime),
        /// read under the request dispatch's own metadata admission. <see cref="EpisodeExternalId.Unread"/> when TMDB isn't set
        /// up, fails or is busy.
        /// </summary>
        /// <param name="tmdb">The shared TMDB cache.</param>
        /// <param name="series">TMDB series id.</param>
        /// <param name="season">TMDB season number.</param>
        /// <param name="episode">TMDB episode number.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>What TMDB lists.</returns>
        internal static async Task<EpisodeExternalId> TmdbAsync(TmdbResponseCache tmdb, int series, int season, int episode, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(key) || series <= 0 || season < 0 || episode < 1) return EpisodeExternalId.Unread;
            var path = string.Create(CultureInfo.InvariantCulture, $"tv/{series}/season/{season}/episode/{episode}/external_ids");
            try
            {
                var response = await AutonomousMetadataAdmission.RunAsync(AutonomousMetadataOwner.RequestDispatch, () => tmdb.GetAsync(path, string.Empty, key, ct), ct).ConfigureAwait(false);
                if (response.StatusCode == 404) return EpisodeExternalId.None;
                return response.IsSuccess ? Parse(response.Content) : EpisodeExternalId.Unread;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return EpisodeExternalId.Unread;
            }
            catch (TimeoutException)
            {
                return EpisodeExternalId.Unread;
            }
            catch (System.Net.Http.HttpRequestException)
            {
                return EpisodeExternalId.Unread;
            }
        }

        /// <summary>The TVDB id in a TMDB external-ids answer (<c>tvdb_id</c>, above zero); an answer that isn't JSON is unread.</summary>
        /// <param name="json">The answer.</param>
        /// <returns>What it lists.</returns>
        internal static EpisodeExternalId Parse(string? json)
        {
            if (string.IsNullOrEmpty(json)) return EpisodeExternalId.Unread;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return EpisodeExternalId.Unread;
                return doc.RootElement.TryGetProperty("tvdb_id", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var tvdb) && tvdb > 0
                    ? new EpisodeExternalId(true, tvdb)
                    : EpisodeExternalId.None;
            }
            catch (JsonException)
            {
                return EpisodeExternalId.Unread;
            }
        }

        /// <summary>
        /// The Sonarr episodes the asks are, by TVDB episode id: an ask is matched only by exactly one Sonarr row carrying its
        /// TVDB id (above zero); anything else (no id, no row, two rows) leaves it unmatched.
        /// </summary>
        /// <param name="asks">The asked episodes (TMDB's numbering).</param>
        /// <param name="tvdb">Each ask's TVDB episode id, as TMDB lists it.</param>
        /// <param name="rows">Sonarr's episode rows of the series.</param>
        /// <returns>The matched Sonarr rows (one per ask, in ask order) and the asks left unmatched.</returns>
        internal static (List<(RequestEpisode Ask, JsonElement Row)> Matched, RequestEpisode[] Unmatched) Match(IReadOnlyList<RequestEpisode> asks, IReadOnlyDictionary<RequestEpisode, int> tvdb, IEnumerable<JsonElement> rows)
        {
            var byId = rows.Select(r => (Row: r, Id: DirectArrBackend.Int(r, "tvdbId") ?? 0)).Where(r => r.Id > 0).GroupBy(r => r.Id).ToDictionary(g => g.Key, g => g.Select(r => r.Row).ToList());
            var matched = new List<(RequestEpisode, JsonElement)>();
            var unmatched = new List<RequestEpisode>();
            foreach (var ask in asks)
            {
                if (tvdb.TryGetValue(ask, out var id) && byId.TryGetValue(id, out var found) && found.Count == 1
                    && DirectArrBackend.Int(found[0], "seasonNumber") is int season && season >= 0 && DirectArrBackend.Int(found[0], "episodeNumber") is int number && number >= 1)
                    matched.Add((ask, found[0]));
                else
                    unmatched.Add(ask);
            }
            return (matched, unmatched.ToArray());
        }

        /// <summary>The renumbering of matched asks: each ask and its Sonarr row's season and number.</summary>
        /// <param name="matched">Matched asks (<see cref="Match"/>).</param>
        /// <returns>The renumbering.</returns>
        internal static IReadOnlyList<EpisodeRenumbering> Renumbering(IEnumerable<(RequestEpisode Ask, JsonElement Row)> matched)
            => matched.Select(m => new EpisodeRenumbering(m.Ask, new RequestEpisode(DirectArrBackend.Int(m.Row, "seasonNumber")!.Value, DirectArrBackend.Int(m.Row, "episodeNumber")!.Value))).ToList();

        /// <summary>
        /// A TMDB-numbered input in Sonarr's numbers by <paramref name="map"/>, or null when it isn't TMDB-numbered episodes or
        /// the map doesn't name every one of its episodes (it is never partly renumbered).
        /// </summary>
        /// <param name="input">The input.</param>
        /// <param name="map">Asked episode to Sonarr episode.</param>
        /// <returns>The renumbered input, or null.</returns>
        internal static MutationInput? Renumber(MutationInput input, IReadOnlyList<EpisodeRenumbering> map)
        {
            if (input.Scope != "episodes" || input.Numbering != Tmdb) return null;
            var to = map.GroupBy(m => m.From).ToDictionary(g => g.Key, g => g.First().To);
            if (input.Episodes.Length == 0 || !input.Episodes.All(to.ContainsKey)) return null;
            return input with
            {
                Numbering = null,
                Episodes = input.Episodes.Select(e => to[e]).Distinct().OrderBy(e => e.Season).ThenBy(e => e.Episode).ToArray(),
            };
        }

        /// <summary>
        /// The TMDB series id a series key stands for: its own TMDB id, else a TMDB alias, else the TMDB id the arr's series (or
        /// lookup) row carries. Null when none is known.
        /// </summary>
        /// <param name="key">The request's series key.</param>
        /// <param name="aliases">Title aliases (null in tests).</param>
        /// <param name="row">The arr's series or lookup row.</param>
        /// <returns>The TMDB series id.</returns>
        internal static int? TmdbSeries(TitleKey key, TitleAliases? aliases, JsonElement? row)
        {
            if (key.Provider == "tmdb" && key.NumericId is int own && own > 0) return own;
            if ((aliases?.Of(key.Title) ?? Array.Empty<TitleKey>()).FirstOrDefault(k => k.Provider == "tmdb" && !k.IsMovie && k.NumericId is > 0) is { NumericId: int alias }) return alias;
            return row is { } r && DirectArrBackend.Int(r, "tmdbId") is int arr && arr > 0 ? arr : null;
        }
    }
}
