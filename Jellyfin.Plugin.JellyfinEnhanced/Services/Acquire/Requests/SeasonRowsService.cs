using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One episode of a season as the season page's request controls see it.</summary>
    public sealed record SeasonRowEpisode
    {
        /// <summary>Episode number.</summary>
        [JsonPropertyName("episode")] public int Episode { get; init; }

        /// <summary>Episode title (only for episodes with no file in Jellyfin).</summary>
        [JsonPropertyName("title")] public string? Title { get; init; }

        /// <summary>Plain-text overview (only for episodes with no file in Jellyfin).</summary>
        [JsonPropertyName("overview")] public string? Overview { get; init; }

        /// <summary>Runtime in minutes.</summary>
        [JsonPropertyName("runtime")] public int? Runtime { get; init; }

        /// <summary>Air date as a calendar day (yyyy-MM-dd).</summary>
        [JsonPropertyName("airDate")] public string? AirDate { get; init; }

        /// <summary>TMDB still path ("/abc.jpg"), validated; the client builds the image URL.</summary>
        [JsonPropertyName("still")] public string? Still { get; init; }

        /// <summary>
        /// The viewer's request state of this episode: waiting (their ask waits for an OK), asked (their
        /// ask is on its way), declined (their ask was declined), household (someone else asked), or null.
        /// </summary>
        [JsonPropertyName("request")] public string? Request { get; init; }
    }

    /// <summary>The season answer: request state and metadata of the episodes Jellyfin has no file for.</summary>
    public sealed record SeasonRows
    {
        /// <summary>Season title key.</summary>
        [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;

        /// <summary>Series title key (what a request names).</summary>
        [JsonPropertyName("series")] public string Series { get; init; } = string.Empty;

        /// <summary>Season number.</summary>
        [JsonPropertyName("season")] public int Season { get; init; }

        /// <summary>The Jellyfin series item (the viewer can open it).</summary>
        [JsonPropertyName("seriesId")] public string SeriesId { get; init; } = string.Empty;

        /// <summary>
        /// The viewer shows missing episodes within seasons (Jellyfin's per-user display setting): the
        /// season page then lists missing episodes as rows; otherwise a banner names them.
        /// </summary>
        [JsonPropertyName("displayMissing")] public bool DisplayMissing { get; init; }

        /// <summary>The viewer may ask for episodes of this series (role, library, rating and backend).</summary>
        [JsonPropertyName("canRequest")] public bool CanRequest { get; init; }

        /// <summary>
        /// Why the viewer can't ask for episodes of this series right now although their role may (for example
        /// <c>low_disk</c>, "Paused: storage full"), shown in place of Get it; null when they can, or can't anyway.
        /// </summary>
        [JsonPropertyName("blocked")] public RequestBlock? Blocked { get; init; }

        /// <summary>The viewer's request state of the whole season (same values as an episode's).</summary>
        [JsonPropertyName("seasonRequest")] public string? SeasonRequest { get; init; }

        /// <summary>Episodes in number order: request state for all, metadata for the ones without a file.</summary>
        [JsonPropertyName("episodes")] public IReadOnlyList<SeasonRowEpisode> Episodes { get; init; } = Array.Empty<SeasonRowEpisode>();
    }

    /// <summary>
    /// Season rows for the "Get it" controls and the episode rows JE draws for missing episodes Jellyfin
    /// has no row for: one read per season page. Metadata comes from TMDB through the shared
    /// <see cref="TmdbResponseCache"/> (server key, cached); request states come from the ledger.
    /// Nothing about instances, paths or other people is returned, and episodes Jellyfin hides from the
    /// viewer (rating, tags, hidden seasons) are left out.
    /// </summary>
    public sealed class SeasonRowsService
    {
        /// <summary>Longest overview sent (characters).</summary>
        public const int MaxOverview = 600;
        private static readonly Regex StillPath = new("^/[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant);
        private static readonly Regex Language = new("^[a-z]{2}(-[A-Z]{2})?$", RegexOptions.CultureInvariant);
        private readonly IArrJellyfinView _view;
        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly TitleAliases? _aliases;
        private readonly Func<int, int, string?, CancellationToken, Task<string?>> _tmdbSeason;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Creates the service over the shared TMDB cache.</summary>
        public SeasonRowsService(IArrJellyfinView view, RequestLedger ledger, IRequestPolicy policy, TitleAliases aliases, TmdbResponseCache tmdb)
            : this(view, ledger, policy, aliases, (id, season, language, ct) => TmdbSeasonAsync(tmdb, id, season, language, ct))
        {
        }

        /// <summary>Creates the service with an explicit TMDB season reader (tests).</summary>
        internal SeasonRowsService(IArrJellyfinView view, RequestLedger ledger, IRequestPolicy policy, TitleAliases? aliases, Func<int, int, string?, CancellationToken, Task<string?>> tmdbSeason, Func<DateTimeOffset>? now = null)
        {
            _view = view;
            _ledger = ledger;
            _policy = policy;
            _aliases = aliases;
            _tmdbSeason = tmdbSeason;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>
        /// The rows of one season item the viewer can see, or null (not a season, not visible to the
        /// viewer, or no usable provider id).
        /// </summary>
        public async Task<SeasonRows?> ForSeasonAsync(StatusViewer viewer, Guid seasonId, string? language, CancellationToken ct)
        {
            if (_view.Resolve(seasonId, viewer) is not { Kind: "season", Key: { } key, SeriesId: Guid seriesId, Season: int season } item) return null;
            var jf = _view.Episodes(seriesId, season, viewer, includeVirtual: true).Where(e => e.Season == season).ToList();
            var hidden = new HashSet<int>(jf.Where(e => e.Hidden).SelectMany(Numbers));
            var withFile = new HashSet<int>(jf.Where(e => !e.Hidden && !e.Virtual).SelectMany(Numbers));
            var series = key.Title;
            var canonical = _aliases?.Canonical(series) ?? series;
            var tmdbId = item.TmdbId ?? _aliases?.Of(series).Append(series).FirstOrDefault(k => k.Provider == "tmdb" && !k.IsMovie)?.NumericId;

            var meta = new Dictionary<int, SeasonRowEpisode>();
            if (tmdbId is int id && id > 0)
            {
                var json = await _tmdbSeason(id, season, language != null && Language.IsMatch(language) ? language : null, ct).ConfigureAwait(false);
                foreach (var episode in ParseSeason(json)) meta[episode.Episode] = episode;
            }

            var probe = new MutationInput { Key = canonical.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(season, 1) } };
            await _policy.PrepareDiskAsync(probe, ct).ConfigureAwait(false);
            var facts = _policy.Evaluate(viewer.UserId, probe);
            var (perEpisode, seasonState) = _ledger.Database.Available
                ? RequestStates(_ledger.ForTitle(canonical.ToString()), viewer.UserId, season, _now(), _policy.Configuration.ArrRequestDeclineCooldownDays, RequestLedger.TargetKey(facts))
                : (new Dictionary<int, string>(), null);

            var canRequest = facts.Refusal == null && facts.CanCreate && facts.Backend is "je" or "seerr";
            var numbers = new SortedSet<int>(meta.Keys);
            numbers.UnionWith(perEpisode.Keys);
            numbers.UnionWith(jf.Where(e => !e.Hidden).SelectMany(Numbers));
            numbers.ExceptWith(hidden);
            var episodes = new List<SeasonRowEpisode>();
            foreach (var n in numbers)
            {
                var info = meta.GetValueOrDefault(n);
                var known = !withFile.Contains(n) && info != null;
                episodes.Add(new SeasonRowEpisode
                {
                    Episode = n,
                    Title = known ? info!.Title : null,
                    Overview = known ? info!.Overview : null,
                    Runtime = known ? info!.Runtime : null,
                    AirDate = known ? info!.AirDate : null,
                    Still = known ? info!.Still : null,
                    Request = perEpisode.GetValueOrDefault(n),
                });
            }

            return new SeasonRows
            {
                Key = key.ToString(),
                Series = canonical.ToString(),
                Season = season,
                SeriesId = seriesId.ToString("N", System.Globalization.CultureInfo.InvariantCulture),
                DisplayMissing = viewer.DisplayMissingEpisodes,
                CanRequest = canRequest,
                Blocked = canRequest ? null : RequestBlock.Of(facts),
                SeasonRequest = seasonState,
                Episodes = episodes,
            };
        }

        /// <summary>
        /// The viewer's request state per episode of a season and of the season as a whole, from the
        /// standard-edition wants on the series (the controls ask for that one; a 4K ask leaves them
        /// alone): the viewer's own asks win over other people's (shown only as "household"), and asks on
        /// <paramref name="currentTarget"/> (where an ask goes now) over asks left on another target, such as an
        /// ask sent to Seerr before requests moved to Jellyfin Enhanced, whose request now waits for an OK here.
        /// </summary>
        internal static (Dictionary<int, string> Episodes, string? Season) RequestStates(IEnumerable<RequestWant> wants, Guid viewer, int season, DateTimeOffset now, int declineCooldownDays, string? currentTarget = null)
        {
            var episodes = new Dictionary<int, string>();
            var elsewhere = new Dictionary<int, string>();
            string? whole = null;
            string? wholeElsewhere = null;
            foreach (var want in wants)
            {
                if (want.Input.Variant != "standard") continue;
                var state = StateOf(want, viewer, now, declineCooldownDays);
                if (state == null) continue;
                var here = currentTarget == null || want.TargetKey == currentTarget;
                var states = here ? episodes : elsewhere;
                var input = want.Input;
                if (input.Scope == "episodes")
                {
                    foreach (var e in input.Episodes.Where(e => e.Season == season)) states[e.Episode] = Stronger(states.GetValueOrDefault(e.Episode), state);
                }
                else if (input.Scope is "seasons" or "future" or "next_season" && input.Seasons.Contains(season))
                {
                    if (here) whole = Stronger(whole, state);
                    else wholeElsewhere = Stronger(wholeElsewhere, state);
                }
            }
            // A whole-season ask on the current target covers every episode, so asks left elsewhere don't show then.
            if (whole == null)
                foreach (var (episode, state) in elsewhere) episodes.TryAdd(episode, state);
            return (episodes, whole ?? wholeElsewhere);
        }

        /// <summary>
        /// What one want means to the viewer: waiting (for an OK), asked (recorded or sent), declined
        /// (their own, only while the decline still blocks asking again, as the ledger does), household
        /// (someone else's open ask), or null.
        /// </summary>
        internal static string? StateOf(RequestWant want, Guid viewer, DateTimeOffset now, int declineCooldownDays)
        {
            var state = want.Status switch
            {
                "pending" => "waiting",
                "queued" or "sent" or "stale" => "asked",
                "declined" => "declined",
                _ => null,
            };
            if (state == "declined" && (want.UserId != viewer || want.UpdatedAt <= now.AddDays(-Math.Clamp(declineCooldownDays, 0, 365)))) return null;
            if (state != null && want.UserId != viewer) return "household";
            return state;
        }

        /// <summary>The state to show when two asks cover the same episode: the viewer's own first.</summary>
        internal static string Stronger(string? current, string next)
        {
            static int Rank(string? s) => s switch { "asked" => 4, "waiting" => 3, "declined" => 2, "household" => 1, _ => 0 };
            return Rank(next) > Rank(current) ? next : current!;
        }

        /// <summary>Parses TMDB's season details into episode metadata (invalid parts left out).</summary>
        internal static IEnumerable<SeasonRowEpisode> ParseSeason(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) yield break;
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(json);
            }
            catch (JsonException)
            {
                yield break;
            }
            using (doc)
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("episodes", out var list) || list.ValueKind != JsonValueKind.Array) yield break;
                foreach (var e in list.EnumerateArray())
                {
                    if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("episode_number", out var number) || number.ValueKind != JsonValueKind.Number || !number.TryGetInt32(out var n) || n < 1 || n > 100000) continue;
                    var overview = Text(e, "overview");
                    if (overview?.Length > MaxOverview) overview = overview[..(MaxOverview - 1)].TrimEnd() + "…";
                    var air = Text(e, "air_date");
                    var still = Text(e, "still_path");
                    int? runtime = e.TryGetProperty("runtime", out var r) && r.ValueKind == JsonValueKind.Number && r.TryGetInt32(out var minutes) && minutes > 0 && minutes < 1000 ? minutes : null;
                    yield return new SeasonRowEpisode
                    {
                        Episode = n,
                        Title = Text(e, "name") is { } name && name.Length > 200 ? name[..200] : Text(e, "name"),
                        Overview = overview,
                        Runtime = runtime,
                        AirDate = air != null && DateTime.TryParseExact(air, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out _) ? air : null,
                        Still = still != null && StillPath.IsMatch(still) ? still : null,
                    };
                }
            }
        }

        private static string? Text(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString()!.Trim() : null;

        private static IEnumerable<int> Numbers(JfEpisode e)
        {
            var end = Math.Min(Math.Max(e.EpisodeEnd ?? e.Episode, e.Episode), e.Episode + 50);
            for (var n = e.Episode; n <= end; n++) yield return n;
        }

        /// <summary>TMDB season details through the shared cache (null when TMDB isn't set up or fails).</summary>
        private static async Task<string?> TmdbSeasonAsync(TmdbResponseCache tmdb, int seriesId, int season, string? language, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(key)) return null;
            try
            {
                var response = await tmdb.GetAsync($"tv/{seriesId}/season/{season}", language == null ? string.Empty : "?language=" + language, key, ct).ConfigureAwait(false);
                return response.IsSuccess ? response.Content : null;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return null;
            }
            catch (System.Net.Http.HttpRequestException)
            {
                return null;
            }
        }
    }
}
