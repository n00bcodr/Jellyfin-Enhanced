using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// Admin "Add to Radarr/Sonarr" for placeholders (design §10): reads quality profiles and root folders, looks titles
    /// up, and adds them straight to JE's configured (enabled) Radarr/Sonarr instances (never following redirects). Sonarr adds honour the
    /// placeholder's scope: a new series gets EVERY season listed with an explicit monitored flag (Sonarr monitors the
    /// seasons it isn't told about) and <c>monitorNewItems:"none"</c> for season/episode scopes; specific episodes are
    /// added all-unmonitored, then monitored once Sonarr's async refresh created them. A series that is already in
    /// Sonarr gets the requested season (season pass for the series/season flags when off, which changes nothing else,
    /// then the episode monitor PUT for whatever is still unmonitored) or episodes (episode monitor PUT) monitored
    /// instead of a duplicate add; for episodes an unmonitored series is switched on through the series editor, which
    /// leaves season and episode flags alone. Upstream bodies are built here from validated fields only; arr error bodies (which can carry stack traces)
    /// are never forwarded.
    /// </summary>
    public sealed class ListPlaceholderArrService
    {
        /// <summary>Radarr service name.</summary>
        public const string Radarr = "radarr";

        /// <summary>Sonarr service name.</summary>
        public const string Sonarr = "sonarr";

        /// <summary>Most lookup candidates returned.</summary>
        public const int MaxLookupResults = 20;

        /// <summary>Longest free-text lookup term.</summary>
        public const int MaxTermLength = 200;

        private const string ReplayScope = "arr-add";
        private const int MaxResponseBytes = 16 * 1024 * 1024;
        private const int MaxRootFolderPath = 4096;

        private static readonly string[] MinimumAvailabilities = { "announced", "inCinemas", "released" };
        private static readonly string[] SeriesTypeNames = { "standard", "daily", "anime" };
        private static readonly Regex IdTermRegex = new("^(tmdb|tvdb|imdb):\\s*(.*)$", RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        private static readonly Regex DigitsRegex = new("^[0-9]{1,9}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex PosterFileRegex = new("^/[A-Za-z0-9_-]+\\.(jpg|png)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex SlugRegex = new("^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex InstanceKeyRegex = new("^[0-9a-f]{16}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex StatusRegex = new("^[A-Za-z]{1,40}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly JsonSerializerOptions ReplayJson = new() { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ListPlaceholderStore _store;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _addLocks = new(StringComparer.Ordinal);

        /// <summary>Creates the service.</summary>
        /// <param name="httpClientFactory">HTTP client factory (arr calls use the no-redirect named client).</param>
        /// <param name="store">Placeholder store (replay cache for retried adds).</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderArrService(IHttpClientFactory httpClientFactory, ListPlaceholderStore store, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _store = store;
            _logger = logger;
        }

        /// <summary>Per upstream call.</summary>
        internal TimeSpan CallTimeout { get; set; } = TimeSpan.FromSeconds(20);

        /// <summary>Whole add (all upstream steps). A started add is not cancelled by the browser going away.</summary>
        internal TimeSpan AddBudget { get; set; } = TimeSpan.FromSeconds(90);

        /// <summary>How long to wait for Sonarr to create a new series' episodes.</summary>
        internal TimeSpan EpisodePollBudget { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>Delay between episode polls.</summary>
        internal TimeSpan EpisodePollInterval { get; set; } = TimeSpan.FromMilliseconds(300);

        /// <summary>Vets an instance URL before each call (DNS included); replaceable in tests.</summary>
        internal Func<string, CancellationToken, Task<bool>> UrlGuard { get; set; } = (url, ct) => ArrUrlGuard.IsAllowedUrlAsync(url, ct);

        /// <summary>Whether the admin arr routes are on (master switch and the arr setting).</summary>
        /// <param name="config">Plugin configuration.</param>
        /// <returns>Whether enabled.</returns>
        public static bool IsEnabled(PluginConfiguration? config) =>
            config != null && config.ListPlaceholdersEnabled && config.ListPlaceholdersArrEnabled;

        /// <summary>The enabled instances of a service that have a URL and an API key, in configuration order (ids are positions here).</summary>
        /// <param name="config">Plugin configuration.</param>
        /// <param name="service"><see cref="Radarr"/> or <see cref="Sonarr"/>.</param>
        /// <returns>Instances.</returns>
        public static List<ArrInstance> Instances(PluginConfiguration config, string service)
        {
            var all = service == Radarr ? config.GetEnabledRadarrInstances() : config.GetEnabledSonarrInstances();
            return all.Where(i => !string.IsNullOrWhiteSpace(i.Url) && !string.IsNullOrWhiteSpace(i.ApiKey)).ToList();
        }

        /// <summary>GET /arr/options: quality profiles and root folders of every enabled instance (read in parallel).</summary>
        /// <param name="mediaType">"movie", "tv" or null for both.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ArrOptionsDto"/>, 400 for a bad type, 404 <c>not_configured</c>.</returns>
        public async Task<ListOutcome> GetOptionsAsync(string? mediaType, CancellationToken cancellationToken)
        {
            if (mediaType != null && mediaType is not ("movie" or "tv"))
            {
                return ListOutcome.Error(400, "invalid_body", "type must be movie or tv.");
            }

            var config = Config();
            var radarr = mediaType is null or "movie" ? Instances(config, Radarr) : new List<ArrInstance>();
            var sonarr = mediaType is null or "tv" ? Instances(config, Sonarr) : new List<ArrInstance>();
            if (radarr.Count == 0 && sonarr.Count == 0)
            {
                return NotConfigured(mediaType == "movie" ? Radarr : mediaType == "tv" ? Sonarr : null);
            }

            var radarrTasks = radarr.Select((instance, index) => ReadOptionsAsync(Radarr, index, instance, cancellationToken)).ToList();
            var sonarrTasks = sonarr.Select((instance, index) => ReadOptionsAsync(Sonarr, index, instance, cancellationToken)).ToList();
            await Task.WhenAll(radarrTasks.Concat(sonarrTasks)).ConfigureAwait(false);
            return ListOutcome.Ok(new ArrOptionsDto
            {
                Radarr = radarrTasks.Select(t => t.Result).ToList(),
                Sonarr = sonarrTasks.Select(t => t.Result).ToList(),
                MinimumAvailability = MinimumAvailabilities.ToList(),
                SeriesTypes = SeriesTypeNames.ToList(),
            });
        }

        /// <summary>GET /arr/lookup: Radarr movie / Sonarr series lookup by <c>tmdb:</c>, <c>tvdb:</c> (TV), <c>imdb:</c> or text.</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="term">Lookup term.</param>
        /// <param name="instanceId">Instance id (default 0).</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ArrLookupResultDto"/> or an error.</returns>
        public async Task<ListOutcome> LookupAsync(string? mediaType, string? term, int? instanceId, CancellationToken cancellationToken)
        {
            if (mediaType is not ("movie" or "tv"))
            {
                return ListOutcome.Error(400, "invalid_body", "type must be movie or tv.");
            }

            if (!TryNormalizeTerm(term, mediaType, out var normalized, out var termError))
            {
                return ListOutcome.Error(400, "invalid_term", termError);
            }

            var service = mediaType == "movie" ? Radarr : Sonarr;
            var (instance, id, instanceError) = ResolveInstance(Config(), service, instanceId ?? 0, null, null);
            if (instanceError != null)
            {
                return instanceError;
            }

            var path = (service == Radarr ? "/api/v3/movie/lookup?term=" : "/api/v3/series/lookup?term=") + Uri.EscapeDataString(normalized);
            var response = await SendAsync(instance!, HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
            if (!response.Ok)
            {
                return Failure(response, instance!, service);
            }

            if (response.Json is not JsonArray hits)
            {
                return Failure(ArrResponse.Fail("arr_invalid_response"), instance!, service);
            }

            var results = new List<ArrCandidateDto>();
            foreach (var hit in hits.OfType<JsonObject>())
            {
                var candidate = service == Radarr ? MapMovie(hit) : MapSeries(hit);
                if (candidate != null)
                {
                    results.Add(candidate);
                    if (results.Count == MaxLookupResults)
                    {
                        break;
                    }
                }
            }

            return ListOutcome.Ok(new ArrLookupResultDto { Instance = Ref(service, id, instance!), Results = results });
        }

        /// <summary>POST /arr/add: adds (or, for a series already in Sonarr, monitors) the requested scope.</summary>
        /// <param name="request">Body.</param>
        /// <param name="userIdN">Calling admin ("N").</param>
        /// <param name="userName">Calling admin's name (log only).</param>
        /// <param name="cancellationToken">Request aborted (only cancels waiting; a started add runs to completion).</param>
        /// <returns><see cref="ArrAddResultDto"/> or an error.</returns>
        public async Task<ListOutcome> AddAsync(ArrAddRequest? request, string userIdN, string userName, CancellationToken cancellationToken)
        {
            if (!TryValidate(request, out var plan, out var validationError))
            {
                return ListOutcome.Error(400, "invalid_body", validationError);
            }

            var (instance, id, instanceError) = ResolveInstance(Config(), plan.Service, plan.InstanceId, plan.InstanceName, plan.InstanceKey);
            if (instanceError != null)
            {
                return instanceError;
            }

            // One add at a time per instance: a double-click with the same requestId waits and then replays.
            var gate = _addLocks.GetOrAdd(plan.Service + "|" + id.ToString(CultureInfo.InvariantCulture), _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var fingerprint = Fingerprint(plan, instance!);
                if (plan.RequestId != null && _store.TryGetReplay(ReplayScope, plan.RequestId, userIdN, out var replay))
                {
                    // Only the add this id was first used for replays: another instance or other choices would
                    // otherwise get that add's result while nothing was sent.
                    return replay.Fingerprint == null || string.Equals(replay.Fingerprint, fingerprint, StringComparison.Ordinal)
                        ? new ListOutcome { StatusCode = replay.StatusCode, RawJson = replay.Body }
                        : ListOutcome.Error(409, "request_mismatch", "This add was already sent with other choices. Open the dialog again.");
                }

                using var budget = new CancellationTokenSource(AddBudget);
                var target = new Target(plan.Service, id, instance!);
                ListOutcome outcome;
                try
                {
                    outcome = plan.Service == Radarr
                        ? await AddMovieAsync(plan, target, budget.Token).ConfigureAwait(false)
                        : await AddSeriesAsync(plan, target, budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (budget.IsCancellationRequested)
                {
                    _logger.Warning($"[ListPlaceholders] Arr add to {target.Name} ran out of time.");
                    return ListOutcome.Error(504, "arr_timeout", $"{target.Name} took too long. Check {target.Name} for what was added.");
                }

                if (outcome.Value is ArrAddResultDto result)
                {
                    _logger.Info($"[ListPlaceholders] {userName} → {target.Name}: {result.Title} ({plan.Scope}{ScopeSuffix(plan)}) → {result.Result}{(result.Searched ? ", search started" : result.SearchFailed == true ? ", search not started" : string.Empty)}.");
                }

                if (plan.RequestId != null && outcome.StatusCode < 300 && outcome.Value != null)
                {
                    _store.RememberReplay(ReplayScope, plan.RequestId, userIdN, outcome.StatusCode, JsonSerializer.Serialize(outcome.Value, outcome.Value.GetType(), ReplayJson), fingerprint);
                }

                return outcome;
            }
            finally
            {
                gate.Release();
            }
        }

        // ── Radarr ───────────────────────────────────────────────────────────

        private async Task<ListOutcome> AddMovieAsync(AddPlan plan, Target target, CancellationToken ct)
        {
            var term = plan.TmdbId.HasValue ? "tmdb:" + Num(plan.TmdbId.Value) : "imdb:" + plan.ImdbId;
            var lookup = await SendAsync(target.Instance, HttpMethod.Get, "/api/v3/movie/lookup?term=" + Uri.EscapeDataString(term), null, ct).ConfigureAwait(false);
            if (!lookup.Ok)
            {
                return Failure(lookup, target.Instance, Radarr);
            }

            var item = (lookup.Json as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
            var tmdbId = PositiveInt(item?["tmdbId"]);
            if (item == null || tmdbId == null)
            {
                return ListOutcome.Error(404, "not_found", $"{target.Name} couldn't find this movie.");
            }

            var title = Text(item["title"], PlaceholderRules.MaxTitle) ?? "TMDB " + Num(tmdbId.Value);
            var arrPath = "/movie/" + Num(tmdbId.Value);
            var existingId = PositiveInt(item["id"]);
            if (existingId != null)
            {
                return Result("already_exists", target, title, existingId, arrPath, searched: false, monitored: Bool(item["monitored"]));
            }

            var body = new JsonObject
            {
                ["title"] = title,
                ["tmdbId"] = tmdbId.Value,
                ["qualityProfileId"] = plan.QualityProfileId,
                ["rootFolderPath"] = plan.RootFolderPath,
                ["monitored"] = true,
                ["minimumAvailability"] = plan.MinimumAvailability,
                ["tags"] = new JsonArray(),
                ["addOptions"] = new JsonObject { ["searchForMovie"] = plan.Search },
            };
            var year = Year(item["year"]);
            if (year != null)
            {
                body["year"] = year.Value;
            }

            var added = await SendAsync(target.Instance, HttpMethod.Post, "/api/v3/movie", body, ct).ConfigureAwait(false);
            if (added.Status == 400 && HasErrorCode(added.Json, "MovieExistsValidator"))
            {
                return Result("already_exists", target, title, null, arrPath, searched: false, monitored: null);
            }

            if (!added.Ok)
            {
                return Failure(added, target.Instance, Radarr);
            }

            if (added.Json is not JsonObject movie)
            {
                return Failure(ArrResponse.Fail("arr_invalid_response"), target.Instance, Radarr);
            }

            return Result("added", target, title, PositiveInt(movie["id"]), arrPath, searched: plan.Search, monitored: true);
        }

        // ── Sonarr ───────────────────────────────────────────────────────────

        private async Task<ListOutcome> AddSeriesAsync(AddPlan plan, Target target, CancellationToken ct)
        {
            var term = plan.TvdbId.HasValue ? "tvdb:" + Num(plan.TvdbId.Value)
                : plan.TmdbId.HasValue ? "tmdb:" + Num(plan.TmdbId.Value)
                : "imdb:" + plan.ImdbId;
            var (item, lookupError) = await LookupSeriesAsync(target, term, ct).ConfigureAwait(false);
            if (lookupError != null)
            {
                return lookupError;
            }

            var tvdbId = PositiveInt(item!["tvdbId"]);
            var title = Text(item["title"], PlaceholderRules.MaxTitle) ?? "TVDB " + Num(tvdbId!.Value);
            var slug = Slug(item["titleSlug"]);
            var existingId = PositiveInt(item["id"]);
            if (existingId != null)
            {
                return await UpdateExistingSeriesAsync(plan, target, existingId.Value, title, slug, Bool(item["monitored"]), ct).ConfigureAwait(false);
            }

            var seasonNumbers = SeasonNumbers(item["seasons"]);
            if (plan.SeasonNumber.HasValue && !seasonNumbers.Contains(plan.SeasonNumber.Value))
            {
                return SeasonNotFound(target, title, plan.SeasonNumber.Value);
            }

            var seasons = new JsonArray();
            foreach (var number in seasonNumbers)
            {
                var monitored = plan.Scope switch
                {
                    "series" => number > 0,
                    "season" => number == plan.SeasonNumber,
                    _ => false,
                };
                seasons.Add(new JsonObject { ["seasonNumber"] = number, ["monitored"] = monitored });
            }

            var body = new JsonObject
            {
                ["title"] = title,
                ["tvdbId"] = tvdbId!.Value,
                ["qualityProfileId"] = plan.QualityProfileId,
                ["rootFolderPath"] = plan.RootFolderPath,
                ["seasonFolder"] = true,
                ["monitored"] = true,
                // "all" would auto-monitor every future season; a season/episode placeholder only wants its own scope.
                ["monitorNewItems"] = plan.Scope == "series" ? "all" : "none",
                ["seriesType"] = plan.SeriesType ?? SeriesType(item["seriesType"]) ?? "standard",
                ["tags"] = new JsonArray(),
                // Every season listed explicitly: Sonarr monitors any season missing from this list. addOptions.monitor
                // stays unset, because "all"/"none" would override these flags.
                ["seasons"] = seasons,
                ["addOptions"] = new JsonObject
                {
                    ["searchForMissingEpisodes"] = plan.Search && plan.Scope != "episodes",
                    ["searchForCutoffUnmetEpisodes"] = false,
                },
            };
            var year = Year(item["year"]);
            if (year != null)
            {
                body["year"] = year.Value;
            }

            var added = await SendAsync(target.Instance, HttpMethod.Post, "/api/v3/series", body, ct).ConfigureAwait(false);
            if (added.Status == 400 && HasErrorCode(added.Json, "SeriesExistsValidator"))
            {
                // Added meanwhile (another admin, Seerr, an import list): monitor the scope on the existing series.
                var (again, againError) = await LookupSeriesAsync(target, "tvdb:" + Num(tvdbId.Value), ct).ConfigureAwait(false);
                var againId = againError == null ? PositiveInt(again!["id"]) : null;
                return againId != null
                    ? await UpdateExistingSeriesAsync(plan, target, againId.Value, title, slug, Bool(again!["monitored"]), ct).ConfigureAwait(false)
                    : Result("already_exists", target, title, null, SeriesPath(slug), searched: false, monitored: null);
            }

            if (!added.Ok)
            {
                return Failure(added, target.Instance, Sonarr);
            }

            if (added.Json is not JsonObject created)
            {
                return Failure(ArrResponse.Fail("arr_invalid_response"), target.Instance, Sonarr);
            }

            var seriesId = PositiveInt(created["id"]);
            slug = Slug(created["titleSlug"]) ?? slug;
            if (plan.Scope != "episodes")
            {
                return Result("added", target, title, seriesId, SeriesPath(slug), searched: plan.Search, monitored: true);
            }

            if (seriesId == null)
            {
                return Failure(ArrResponse.Fail("arr_invalid_response"), target.Instance, Sonarr);
            }

            // Episodes appear only after Sonarr's async RefreshSeries (~0.3 s, longer for big shows).
            var (episodes, pollFailure) = await PollEpisodesAsync(target, seriesId.Value, plan.SeasonNumber!.Value, plan.Episodes, ct).ConfigureAwait(false);
            if (pollFailure != null)
            {
                _logger.Warning($"[ListPlaceholders] {title} was added to {target.Name}, but its episodes couldn't be read: {pollFailure.FailureCode ?? "HTTP " + Num(pollFailure.Status)}.");
                return PartialAdd(target, title);
            }

            var (found, missing) = MatchEpisodes(episodes!, plan.SeasonNumber.Value, plan.Episodes);
            var searched = false;
            if (found.Count > 0)
            {
                var monitor = await MonitorEpisodesAsync(target, found.Select(e => e.Id), ct).ConfigureAwait(false);
                if (!monitor.Ok)
                {
                    return PartialAdd(target, title);
                }

                searched = plan.Search && await SearchAsync(target, new JsonObject { ["name"] = "EpisodeSearch", ["episodeIds"] = IdArray(found.Select(e => e.Id)) }, ct).ConfigureAwait(false);
            }

            var outcome = Result("added", target, title, seriesId, SeriesPath(slug), searched, monitored: true, searchFailed: plan.Search && found.Count > 0 && !searched);
            var dto = (ArrAddResultDto)outcome.Value!;
            dto.MonitoredEpisodes = found.Count;
            dto.MissingEpisodes = missing.Count > 0 ? missing : null;
            return outcome;
        }

        private async Task<ListOutcome> UpdateExistingSeriesAsync(AddPlan plan, Target target, int seriesId, string title, string? slug, bool? lookupMonitored, CancellationToken ct)
        {
            var path = SeriesPath(slug);
            if (plan.Scope == "series")
            {
                return Result("already_exists", target, title, seriesId, path, searched: false, monitored: lookupMonitored);
            }

            var seasonNumber = plan.SeasonNumber!.Value;
            var episodesResponse = await SendAsync(target.Instance, HttpMethod.Get, EpisodesPath(seriesId, seasonNumber), null, ct).ConfigureAwait(false);
            if (!episodesResponse.Ok)
            {
                return Failure(episodesResponse, target.Instance, Sonarr);
            }

            var seasonEpisodes = ParseEpisodes(episodesResponse.Json).Where(e => e.Season == seasonNumber).ToList();
            var seriesResponse = await SendAsync(target.Instance, HttpMethod.Get, "/api/v3/series/" + Num(seriesId), null, ct).ConfigureAwait(false);
            if (!seriesResponse.Ok)
            {
                return Failure(seriesResponse, target.Instance, Sonarr);
            }

            if (seriesResponse.Json is not JsonObject series || series["seasons"] is not JsonArray seasons)
            {
                return Failure(ArrResponse.Fail("arr_invalid_response"), target.Instance, Sonarr);
            }

            var season = seasons.OfType<JsonObject>().FirstOrDefault(s => Int(s["seasonNumber"]) == seasonNumber);
            if (season == null)
            {
                return SeasonNotFound(target, title, seasonNumber);
            }

            var seriesMonitored = Bool(series["monitored"]) == true;
            if (plan.Scope == "season")
            {
                return await MonitorExistingSeasonAsync(plan, target, seriesId, title, path, season, seriesMonitored, seasonEpisodes, ct).ConfigureAwait(false);
            }

            var (found, missing) = MatchEpisodes(seasonEpisodes, seasonNumber, plan.Episodes);
            if (found.Count == 0)
            {
                return ListOutcome.Error(404, "episodes_not_found", $"{target.Name} has none of these episodes of {title} (yet).");
            }

            var toMonitor = found.Where(e => !e.Monitored).Select(e => e.Id).ToList();
            if (toMonitor.Count == 0 && seriesMonitored)
            {
                var already = Result("already_monitored", target, title, seriesId, path, searched: false, monitored: true);
                ((ArrAddResultDto)already.Value!).MonitoredEpisodes = 0;
                ((ArrAddResultDto)already.Value!).MissingEpisodes = missing.Count > 0 ? missing : null;
                return already;
            }

            if (!seriesMonitored)
            {
                // An unmonitored series is never searched; switch it on first and only then flag the episodes.
                var on = await MonitorSeriesAsync(target, seriesId, ct).ConfigureAwait(false);
                if (!on.Ok)
                {
                    return Failure(on, target.Instance, Sonarr);
                }
            }

            if (toMonitor.Count > 0)
            {
                var monitor = await MonitorEpisodesAsync(target, toMonitor, ct).ConfigureAwait(false);
                if (!monitor.Ok)
                {
                    return Failure(monitor, target.Instance, Sonarr);
                }
            }

            var searched = plan.Search && await SearchAsync(target, new JsonObject { ["name"] = "EpisodeSearch", ["episodeIds"] = IdArray(found.Select(e => e.Id)) }, ct).ConfigureAwait(false);
            var outcome = Result("monitoring_added", target, title, seriesId, path, searched, monitored: true, searchFailed: plan.Search && !searched);
            var dto = (ArrAddResultDto)outcome.Value!;
            dto.MonitoredEpisodes = toMonitor.Count;
            dto.MissingEpisodes = missing.Count > 0 ? missing : null;
            return outcome;
        }

        /// <summary>
        /// Season scope on a series already in Sonarr. "Already monitored" needs the series, the season flag AND every
        /// episode of the season monitored: Sonarr keeps a season flag on while its episodes are unmonitored (episode
        /// edits, the "existing/missing/future" add options). The flags go through the season pass (only the series flag
        /// and this season's flag, applied to the series as Sonarr has it then), never a full series PUT: that would send
        /// back every season flag JE read, and Sonarr re-flags the episodes of any season whose flag differs, undoing an
        /// edit made in Sonarr (or by Seerr) meanwhile.
        /// </summary>
        private async Task<ListOutcome> MonitorExistingSeasonAsync(AddPlan plan, Target target, int seriesId, string title, string? path, JsonObject season, bool seriesMonitored, List<ArrEpisode> seasonEpisodes, CancellationToken ct)
        {
            var seasonNumber = plan.SeasonNumber!.Value;
            var seasonFlag = Bool(season["monitored"]) == true;
            var unmonitored = seasonEpisodes.Where(e => !e.Monitored).Select(e => e.Id).ToList();
            if (seasonFlag && seriesMonitored && unmonitored.Count == 0)
            {
                return Result("already_monitored", target, title, seriesId, path, searched: false, monitored: true);
            }

            if (!seasonFlag || !seriesMonitored)
            {
                var flags = await MonitorSeasonFlagAsync(target, seriesId, seasonNumber, ct).ConfigureAwait(false);
                if (!flags.Ok)
                {
                    return Failure(flags, target.Instance, Sonarr);
                }
            }

            // The season pass leaves episode flags alone, so the season's unmonitored episodes are flagged explicitly
            // (what Sonarr itself does when a season flag is switched on in its UI).
            if (unmonitored.Count > 0)
            {
                var monitor = await MonitorEpisodesAsync(target, unmonitored, ct).ConfigureAwait(false);
                if (!monitor.Ok)
                {
                    return Failure(monitor, target.Instance, Sonarr);
                }
            }

            var searched = plan.Search && await SearchAsync(target, new JsonObject { ["name"] = "SeasonSearch", ["seriesId"] = seriesId, ["seasonNumber"] = seasonNumber }, ct).ConfigureAwait(false);
            return Result("monitoring_added", target, title, seriesId, path, searched, monitored: true, searchFailed: plan.Search && !searched);
        }

        private async Task<(JsonObject? Item, ListOutcome? Error)> LookupSeriesAsync(Target target, string term, CancellationToken ct)
        {
            var lookup = await SendAsync(target.Instance, HttpMethod.Get, "/api/v3/series/lookup?term=" + Uri.EscapeDataString(term), null, ct).ConfigureAwait(false);
            if (!lookup.Ok)
            {
                return (null, Failure(lookup, target.Instance, Sonarr));
            }

            var item = (lookup.Json as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
            if (item == null || PositiveInt(item["tvdbId"]) == null)
            {
                return (null, ListOutcome.Error(404, "not_found", $"{target.Name} couldn't find this series."));
            }

            return (item, null);
        }

        private async Task<(List<ArrEpisode>? Episodes, ArrResponse? Failure)> PollEpisodesAsync(Target target, int seriesId, int seasonNumber, IReadOnlyList<int> wanted, CancellationToken ct)
        {
            var deadline = DateTime.UtcNow + EpisodePollBudget;
            var previousCount = -1;
            while (true)
            {
                var response = await SendAsync(target.Instance, HttpMethod.Get, EpisodesPath(seriesId, seasonNumber), null, ct).ConfigureAwait(false);
                if (!response.Ok)
                {
                    return (null, response);
                }

                var episodes = ParseEpisodes(response.Json);
                var (found, _) = MatchEpisodes(episodes, seasonNumber, wanted);

                // Done when every wanted episode exists, or the season is populated and stopped growing (the rest
                // simply don't exist in Sonarr's metadata).
                if (found.Count == wanted.Count || (episodes.Count > 0 && episodes.Count == previousCount))
                {
                    return (episodes, null);
                }

                // Out of time while the season is still empty or still growing: Sonarr hasn't finished its refresh, so
                // the episodes we'd leave out would later appear unmonitored. That's a failure, never a finished add.
                if (DateTime.UtcNow >= deadline)
                {
                    return (null, ArrResponse.Fail("arr_timeout"));
                }

                previousCount = episodes.Count;
                await Task.Delay(EpisodePollInterval, ct).ConfigureAwait(false);
            }
        }

        private Task<ArrResponse> MonitorEpisodesAsync(Target target, IEnumerable<int> episodeIds, CancellationToken ct) =>
            SendAsync(target.Instance, HttpMethod.Put, "/api/v3/episode/monitor", new JsonObject { ["episodeIds"] = IdArray(episodeIds), ["monitored"] = true }, ct);

        /// <summary>Switches only <c>series.monitored</c> on (series editor: no seasons sent, so no episode flag changes).</summary>
        private Task<ArrResponse> MonitorSeriesAsync(Target target, int seriesId, CancellationToken ct) =>
            SendAsync(target.Instance, HttpMethod.Put, "/api/v3/series/editor", new JsonObject { ["seriesIds"] = IdArray(new[] { seriesId }), ["monitored"] = true }, ct);

        /// <summary>
        /// Switches <c>series.monitored</c> and one season's flag on through the season pass. Sonarr applies them to the
        /// stored series; without <c>monitoringOptions</c> no episode flag changes and no other season is touched.
        /// </summary>
        private Task<ArrResponse> MonitorSeasonFlagAsync(Target target, int seriesId, int seasonNumber, CancellationToken ct) =>
            SendAsync(target.Instance, HttpMethod.Post, "/api/v3/seasonpass", new JsonObject
            {
                ["series"] = new JsonArray(new JsonObject
                {
                    ["id"] = seriesId,
                    ["monitored"] = true,
                    ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = seasonNumber, ["monitored"] = true }),
                }),
            }, ct);

        private async Task<bool> SearchAsync(Target target, JsonObject command, CancellationToken ct)
        {
            var response = await SendAsync(target.Instance, HttpMethod.Post, "/api/v3/command", command, ct).ConfigureAwait(false);
            if (!response.Ok)
            {
                _logger.Warning($"[ListPlaceholders] {target.Name} didn't start the {Text(command["name"], 40)}: {response.FailureCode ?? "HTTP " + Num(response.Status)}.");
            }

            return response.Ok;
        }

        // ── Validation ───────────────────────────────────────────────────────

        private static bool TryValidate(ArrAddRequest? request, out AddPlan plan, out string error)
        {
            plan = null!;
            error = string.Empty;
            if (request == null)
            {
                error = "A body is required.";
                return false;
            }

            if (request.RequestId != null && !ListPlaceholderStore.IsValidRequestId(request.RequestId))
            {
                error = "Invalid requestId.";
                return false;
            }

            var service = request.MediaType switch { "movie" => Radarr, "tv" => Sonarr, _ => null };
            if (service == null)
            {
                error = "mediaType must be movie or tv.";
                return false;
            }

            if (request.Instance is not >= 0)
            {
                error = "instance is required.";
                return false;
            }

            if (request.TmdbId is <= 0 || request.TvdbId is <= 0 || (service == Radarr && request.TvdbId.HasValue))
            {
                error = "Invalid tmdbId/tvdbId.";
                return false;
            }

            var imdb = string.IsNullOrWhiteSpace(request.ImdbId) ? null : request.ImdbId.Trim();
            if (imdb != null && !ImdbRegex.IsMatch(imdb))
            {
                error = "Invalid imdbId.";
                return false;
            }

            if (request.TmdbId == null && request.TvdbId == null && imdb == null)
            {
                error = "A tmdbId, tvdbId or imdbId is required.";
                return false;
            }

            if (request.QualityProfileId is not > 0)
            {
                error = "qualityProfileId is required.";
                return false;
            }

            var root = request.RootFolderPath ?? string.Empty;
            if (root.Trim().Length == 0 || root.Length > MaxRootFolderPath || root.Any(char.IsControl))
            {
                error = "rootFolderPath is required.";
                return false;
            }

            var scope = request.Scope;
            if (service == Radarr ? scope != "movie" : scope is not ("series" or "season" or "episodes"))
            {
                error = service == Radarr ? "Movies use scope movie." : "scope must be series, season or episodes.";
                return false;
            }

            if (scope is "season" or "episodes")
            {
                if (request.SeasonNumber is not (>= 0 and <= 200))
                {
                    error = "seasonNumber 0-200 is required.";
                    return false;
                }
            }
            else if (request.SeasonNumber.HasValue)
            {
                error = "seasonNumber only applies to the season and episodes scopes.";
                return false;
            }

            var episodes = new List<int>();
            if (scope == "episodes")
            {
                if (request.Episodes == null || request.Episodes.Count == 0 || request.Episodes.Count > PlaceholderRules.MaxEpisodes)
                {
                    error = "Send 1-100 episodes.";
                    return false;
                }

                foreach (var episode in request.Episodes)
                {
                    if (episode == null || episode.S != request.SeasonNumber || episode.E is < 0 or > 10000)
                    {
                        error = "Every episode must be in seasonNumber.";
                        return false;
                    }

                    episodes.Add(episode.E);
                }

                episodes = episodes.Distinct().OrderBy(e => e).ToList();
            }
            else if (request.Episodes is { Count: > 0 })
            {
                error = "episodes only apply to the episodes scope.";
                return false;
            }

            var availability = request.MinimumAvailability ?? "released";
            if (service == Radarr ? !MinimumAvailabilities.Contains(availability, StringComparer.Ordinal) : request.MinimumAvailability != null)
            {
                error = "minimumAvailability must be announced, inCinemas or released.";
                return false;
            }

            if (request.SeriesType != null && (service != Sonarr || !SeriesTypeNames.Contains(request.SeriesType, StringComparer.Ordinal)))
            {
                error = "seriesType must be standard, daily or anime.";
                return false;
            }

            if (request.InstanceKey != null && !InstanceKeyRegex.IsMatch(request.InstanceKey))
            {
                error = "Invalid instanceKey.";
                return false;
            }

            var instanceName = request.InstanceName == null ? null : PlaceholderRules.CleanText(request.InstanceName);
            plan = new AddPlan(
                service,
                request.Instance.Value,
                string.IsNullOrEmpty(instanceName) ? null : instanceName,
                request.InstanceKey,
                request.TmdbId,
                service == Sonarr ? request.TvdbId : null,
                imdb,
                scope!,
                request.SeasonNumber,
                episodes,
                request.QualityProfileId.Value,
                root,
                request.Search,
                availability,
                request.SeriesType,
                request.RequestId);
            return true;
        }

        /// <summary>Normalises a lookup term: <c>tmdb:N</c>, <c>tvdb:N</c> (TV only), <c>imdb:ttN</c>, or 1-200 characters of text.</summary>
        /// <param name="term">Raw term.</param>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="normalized">Term to send.</param>
        /// <param name="error">Why it was refused.</param>
        /// <returns>Whether the term is usable.</returns>
        internal static bool TryNormalizeTerm(string? term, string mediaType, out string normalized, out string error)
        {
            normalized = string.Empty;
            error = string.Empty;
            var text = PlaceholderRules.CleanText(term);
            if (text.Length == 0 || text.Length > MaxTermLength)
            {
                error = "term must be 1-200 characters.";
                return false;
            }

            var match = IdTermRegex.Match(text);
            if (!match.Success)
            {
                normalized = text;
                return true;
            }

            var prefix = match.Groups[1].Value.ToLowerInvariant();
            var value = match.Groups[2].Value.Trim();
            switch (prefix)
            {
                case "tmdb" or "tvdb" when DigitsRegex.IsMatch(value) && int.Parse(value, CultureInfo.InvariantCulture) > 0:
                    if (prefix == "tvdb" && mediaType != "tv")
                    {
                        error = "tvdb: lookups are for TV.";
                        return false;
                    }

                    normalized = prefix + ":" + int.Parse(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
                    return true;
                case "imdb" when ImdbRegex.IsMatch(value.ToLowerInvariant()):
                    normalized = "imdb:" + value.ToLowerInvariant();
                    return true;
                default:
                    error = $"Invalid {prefix}: id.";
                    return false;
            }
        }

        // ── Candidate mapping ────────────────────────────────────────────────

        /// <summary>Maps a Radarr lookup hit (null when it has no TMDB id or title).</summary>
        /// <param name="hit">Radarr movie resource.</param>
        /// <returns>The candidate.</returns>
        internal static ArrCandidateDto? MapMovie(JsonObject hit)
        {
            var tmdbId = PositiveInt(hit["tmdbId"]);
            var title = Text(hit["title"], PlaceholderRules.MaxTitle);
            if (tmdbId == null || title == null)
            {
                return null;
            }

            var arrId = PositiveInt(hit["id"]);
            var posterUrl = PosterUrl(hit);
            return new ArrCandidateDto
            {
                MediaType = "movie",
                TmdbId = tmdbId,
                ImdbId = Imdb(hit["imdbId"]),
                Title = title,
                Year = Year(hit["year"]),
                ReleaseDate = Date(hit["releaseDate"]) ?? Date(hit["inCinemas"]) ?? Date(hit["digitalRelease"]) ?? Date(hit["physicalRelease"]),
                PosterUrl = posterUrl,
                PosterPath = TmdbPosterPath(posterUrl),
                Overview = Text(hit["overview"], PlaceholderRules.MaxOverview, cut: true),
                InArr = arrId != null,
                ArrId = arrId,
                Monitored = arrId != null ? Bool(hit["monitored"]) : null,
                Status = Status(hit["status"]),
            };
        }

        /// <summary>Maps a Sonarr lookup hit (null when it has no TVDB id or title).</summary>
        /// <param name="hit">Sonarr series resource.</param>
        /// <returns>The candidate.</returns>
        internal static ArrCandidateDto? MapSeries(JsonObject hit)
        {
            var tvdbId = PositiveInt(hit["tvdbId"]);
            var title = Text(hit["title"], PlaceholderRules.MaxTitle);
            if (tvdbId == null || title == null)
            {
                return null;
            }

            var arrId = PositiveInt(hit["id"]);
            var posterUrl = PosterUrl(hit);
            var seasons = new List<ArrSeasonDto>();
            if (hit["seasons"] is JsonArray array)
            {
                foreach (var season in array.OfType<JsonObject>())
                {
                    var number = Int(season["seasonNumber"]);
                    if (number is >= 0 and <= 200 && seasons.All(s => s.SeasonNumber != number))
                    {
                        seasons.Add(new ArrSeasonDto { SeasonNumber = number.Value, Monitored = Bool(season["monitored"]) == true });
                    }
                }
            }

            return new ArrCandidateDto
            {
                MediaType = "tv",
                TvdbId = tvdbId,
                TmdbId = PositiveInt(hit["tmdbId"]),
                ImdbId = Imdb(hit["imdbId"]),
                Title = title,
                Year = Year(hit["year"]),
                ReleaseDate = Date(hit["firstAired"]),
                PosterUrl = posterUrl,
                PosterPath = TmdbPosterPath(posterUrl),
                Overview = Text(hit["overview"], PlaceholderRules.MaxOverview, cut: true),
                InArr = arrId != null,
                ArrId = arrId,
                Monitored = arrId != null ? Bool(hit["monitored"]) : null,
                Status = Status(hit["status"]),
                TitleSlug = Slug(hit["titleSlug"]),
                SeriesType = SeriesType(hit["seriesType"]),
                Seasons = seasons.OrderBy(s => s.SeasonNumber).ToList(),
            };
        }

        // ── Transport ────────────────────────────────────────────────────────

        private async Task<ArrInstanceOptionsDto> ReadOptionsAsync(string service, int id, ArrInstance instance, CancellationToken ct)
        {
            var dto = new ArrInstanceOptionsDto { Id = id, Name = DisplayName(instance, service), Key = InstanceKey(service, instance) };
            var profilesTask = SendAsync(instance, HttpMethod.Get, "/api/v3/qualityprofile", null, ct);
            var foldersTask = SendAsync(instance, HttpMethod.Get, "/api/v3/rootfolder", null, ct);
            var profiles = await profilesTask.ConfigureAwait(false);
            var folders = await foldersTask.ConfigureAwait(false);
            var failed = !profiles.Ok ? profiles : !folders.Ok ? folders : null;
            if (failed == null && (profiles.Json is not JsonArray || folders.Json is not JsonArray))
            {
                failed = ArrResponse.Fail("arr_invalid_response");
            }

            if (failed != null)
            {
                var (_, code, message) = Describe(failed, dto.Name);
                dto.Error = code;
                dto.Message = message;
                return dto;
            }

            foreach (var profile in ((JsonArray)profiles.Json!).OfType<JsonObject>())
            {
                var profileId = PositiveInt(profile["id"]);
                if (profileId != null)
                {
                    dto.QualityProfiles.Add(new ArrQualityProfileDto { Id = profileId.Value, Name = Text(profile["name"], 100) ?? "Profile " + Num(profileId.Value) });
                }
            }

            foreach (var folder in ((JsonArray)folders.Json!).OfType<JsonObject>())
            {
                var path = Str(folder["path"]);
                if (!string.IsNullOrWhiteSpace(path) && path.Length <= MaxRootFolderPath && !path.Any(char.IsControl))
                {
                    dto.RootFolders.Add(new ArrRootFolderDto { Path = path, FreeSpace = Long(folder["freeSpace"]), Accessible = Bool(folder["accessible"]) != false });
                }
            }

            return dto;
        }

        private async Task<ArrResponse> SendAsync(ArrInstance instance, HttpMethod method, string path, JsonNode? body, CancellationToken ct)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(CallTimeout);
            try
            {
                // Inside the per-call limit: the guard resolves the host name, which can hang too.
                if (!await UrlGuard(instance.Url, timeout.Token).ConfigureAwait(false))
                {
                    return ArrResponse.Fail("arr_url_rejected");
                }

                // Never follow redirects: ArrUrlGuard only vetted the configured URL, the X-Api-Key header would travel
                // to the redirect target, and a 301/302 turns a POST into a body-less GET that "succeeds".
                var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
                using var request = new HttpRequestMessage(method, instance.Url.Trim().TrimEnd('/') + path);
                // Per request, never on DefaultRequestHeaders (pooled clients are shared).
                request.Headers.TryAddWithoutValidation("X-Api-Key", instance.ApiKey);
                request.Headers.TryAddWithoutValidation("Accept", "application/json");
                if (body != null)
                {
                    request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
                }

                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
                var status = (int)response.StatusCode;
                if (status is >= 300 and < 400)
                {
                    _logger.Warning($"[ListPlaceholders] {DisplayName(instance, string.Empty)} redirected {method} {PathOnly(path)} (HTTP {Num(status)}); set its URL in Jellyfin Enhanced to the final address.");
                    return ArrResponse.Fail("arr_redirect", status);
                }

                if (status is 401 or 403)
                {
                    _logger.Warning($"[ListPlaceholders] {DisplayName(instance, string.Empty)} refused JE's API key (HTTP {Num(status)}) on {method} {PathOnly(path)}.");
                    return ArrResponse.Fail("arr_auth_failed", status);
                }

                var text = await ReadCappedAsync(response.Content, timeout.Token).ConfigureAwait(false);
                if (text == null)
                {
                    return ArrResponse.Fail("arr_invalid_response", status);
                }

                JsonNode? json = null;
                if (text.Length > 0)
                {
                    try
                    {
                        json = JsonNode.Parse(text);
                    }
                    catch (JsonException)
                    {
                        if (status is >= 200 and < 300)
                        {
                            return ArrResponse.Fail("arr_invalid_response", status);
                        }
                    }
                }

                if (status is < 200 or >= 300)
                {
                    _logger.Warning($"[ListPlaceholders] {DisplayName(instance, string.Empty)} answered HTTP {Num(status)} to {method} {PathOnly(path)}.");
                }

                return new ArrResponse(status, json, null);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                _logger.Warning($"[ListPlaceholders] {DisplayName(instance, string.Empty)} timed out on {method} {PathOnly(path)}.");
                return ArrResponse.Fail("arr_timeout");
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UriFormatException)
            {
                _logger.Warning($"[ListPlaceholders] Couldn't reach {DisplayName(instance, string.Empty)} ({method} {PathOnly(path)}): {ex.Message}");
                return ArrResponse.Fail("arr_unreachable");
            }
        }

        private static async Task<string?> ReadCappedAsync(HttpContent content, CancellationToken ct)
        {
            await using var stream = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk.AsMemory(0, chunk.Length), ct).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > MaxResponseBytes)
                {
                    return null;
                }

                buffer.Write(chunk, 0, read);
            }

            return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
        }

        // ── Results and errors ───────────────────────────────────────────────

        private static ListOutcome Result(string result, Target target, string title, int? arrId, string? arrPath, bool searched, bool? monitored, bool searchFailed = false) =>
            ListOutcome.Ok(new ArrAddResultDto
            {
                Result = result,
                Instance = Ref(target.Service, target.Id, target.Instance),
                Title = title,
                ArrId = arrId,
                ArrPath = arrPath,
                Searched = searched,
                SearchFailed = searchFailed ? true : null,
                Monitored = monitored,
            });

        private static ListOutcome PartialAdd(Target target, string title) =>
            ListOutcome.Error(502, "partial_add", $"{title} was added to {target.Name}, but its episodes couldn't be monitored. Finish it in {target.Name}.");

        private static ListOutcome SeasonNotFound(Target target, string title, int seasonNumber) =>
            ListOutcome.Error(404, "season_not_found", $"{target.Name} doesn't know season {Num(seasonNumber)} of {title} (yet).");

        private static ListOutcome NotConfigured(string? service) =>
            ListOutcome.Error(404, "not_configured", service == Radarr ? "No Radarr instance is configured." : service == Sonarr ? "No Sonarr instance is configured." : "No Radarr or Sonarr instance is configured.");

        /// <summary>Maps an upstream failure to a client error without any upstream body detail beyond validation messages.</summary>
        private static ListOutcome Failure(ArrResponse response, ArrInstance instance, string service)
        {
            var (status, code, message) = Describe(response, DisplayName(instance, service));
            return ListOutcome.Error(status, code, message);
        }

        private static (int Status, string Code, string Message) Describe(ArrResponse response, string name)
        {
            switch (response.FailureCode)
            {
                case "arr_url_rejected":
                    return (502, "arr_url_rejected", $"{name}'s URL isn't allowed.");
                case "arr_redirect":
                    return (502, "arr_redirect", $"{name} redirected the request. In Jellyfin Enhanced, set its URL to the final address it redirects to (often https).");
                case "arr_auth_failed":
                    // Never 401/403: the client would read that as its own Jellyfin session failing.
                    return (502, "arr_auth_failed", $"{name} rejected the API key configured in Jellyfin Enhanced.");
                case "arr_timeout":
                    return (504, "arr_timeout", $"{name} didn't answer in time.");
                case "arr_unreachable":
                    return (502, "arr_unreachable", $"Couldn't reach {name}.");
                case "arr_invalid_response":
                    return (502, "arr_invalid_response", $"{name} sent an unexpected response.");
            }

            if (response.Status == 400)
            {
                // FluentValidation array: [{propertyName, errorMessage, errorCode, ...}]. ProblemDetails/other shapes
                // (bad enum, model binding) get a generic message.
                if (HasErrorCode(response.Json, "QualityProfileExistsValidator"))
                {
                    return (400, "invalid_quality_profile", $"That quality profile doesn't exist in {name} any more.");
                }

                if (HasErrorCode(response.Json, "RootFolderExistsValidator") || HasErrorCode(response.Json, "RootFolderValidator") || HasErrorCode(response.Json, "PathExistsValidator"))
                {
                    return (400, "invalid_root_folder", $"That root folder isn't usable in {name}.");
                }

                var first = (response.Json as JsonArray)?.OfType<JsonObject>().Select(e => Text(e["errorMessage"], 200)).FirstOrDefault(m => m != null);
                return (400, "arr_rejected", first != null ? $"{name} refused: {first}" : $"{name} refused the request.");
            }

            if (response.Status == 404)
            {
                return (404, "arr_not_found", $"{name} doesn't have that (any more).");
            }

            return (502, "arr_error", $"{name} returned an error (HTTP {Num(response.Status)}).");
        }

        private static bool HasErrorCode(JsonNode? json, string code) =>
            json is JsonArray errors && errors.OfType<JsonObject>().Any(e => string.Equals(Str(e["errorCode"]), code, StringComparison.Ordinal));

        private (ArrInstance? Instance, int Id, ListOutcome? Error) ResolveInstance(PluginConfiguration config, string service, int id, string? expectedName, string? expectedKey)
        {
            if (service == Radarr ? config.IsRadarrInstancesCorrupt() : config.IsSonarrInstancesCorrupt())
            {
                _logger.Warning($"[ListPlaceholders] The {(service == Radarr ? "Radarr" : "Sonarr")} instance list in the plugin configuration can't be read.");
            }

            var instances = Instances(config, service);
            if (instances.Count == 0)
            {
                return (null, id, NotConfigured(service));
            }

            if (id < 0 || id >= instances.Count)
            {
                return (null, id, ListOutcome.Error(400, "invalid_instance", "Unknown instance."));
            }

            if ((expectedName != null && !string.Equals(DisplayName(instances[id], service), expectedName, StringComparison.Ordinal))
                || (expectedKey != null && !string.Equals(InstanceKey(service, instances[id]), expectedKey, StringComparison.Ordinal)))
            {
                return (null, id, ListOutcome.Error(409, "instance_changed", "The Radarr/Sonarr settings changed meanwhile. Open the dialog again."));
            }

            return (instances[id], id, null);
        }

        private static PluginConfiguration Config() => JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration();

        private static ArrInstanceRefDto Ref(string service, int id, ArrInstance instance) => new()
        {
            Service = service,
            Id = id,
            Name = DisplayName(instance, service),
            InstanceUrl = instance.Url.Trim().TrimEnd('/'),
            UrlMappings = instance.UrlMappings ?? string.Empty,
        };

        /// <summary>Stable per-instance key: 16 hex chars of SHA-256 over the service and the normalised URL (never the API key).</summary>
        /// <param name="service"><see cref="Radarr"/> or <see cref="Sonarr"/>.</param>
        /// <param name="instance">Instance.</param>
        /// <returns>The key.</returns>
        internal static string InstanceKey(string service, ArrInstance instance)
        {
            var url = (instance.Url ?? string.Empty).Trim().TrimEnd('/').ToLowerInvariant();
            var hash = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(service + "\n" + url));
            return Convert.ToHexString(hash, 0, 8).ToLowerInvariant();
        }

        private static string DisplayName(ArrInstance instance, string service)
        {
            var name = PlaceholderRules.CleanText(instance.Name);
            if (name.Length > 0)
            {
                // The dialog sends this name back for ResolveInstance to compare: never end it in half an emoji or in
                // spaces (CleanText trims what comes back).
                return name.Length > 100 ? name[..(char.IsHighSurrogate(name[99]) ? 99 : 100)].TrimEnd() : name;
            }

            return service == Radarr ? "Radarr" : service == Sonarr ? "Sonarr" : "The arr instance";
        }

        // ── Small JSON helpers (arr payloads are loosely typed; never throw on odd values) ──

        private static string Num(int value) => value.ToString(CultureInfo.InvariantCulture);

        private static string PathOnly(string path)
        {
            var query = path.IndexOf('?', StringComparison.Ordinal);
            return query < 0 ? path : path[..query];
        }

        private static string ScopeSuffix(AddPlan plan) =>
            plan.Scope == "season" ? " " + Num(plan.SeasonNumber!.Value)
            : plan.Scope == "episodes" ? " S" + Num(plan.SeasonNumber!.Value) + " E" + string.Join(",", plan.Episodes.Select(Num))
            : string.Empty;

        /// <summary>
        /// Digest of everything an add does (instance by its key, ids, scope and choices), never the request id or the
        /// display name: a retried request id is only replayed for the same add.
        /// </summary>
        private static string Fingerprint(AddPlan plan, ArrInstance instance)
        {
            var parts = string.Join(
                "\n",
                plan.Service,
                Num(plan.InstanceId),
                InstanceKey(plan.Service, instance),
                plan.TmdbId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                plan.TvdbId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                plan.ImdbId ?? string.Empty,
                plan.Scope,
                plan.SeasonNumber?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                string.Join(",", plan.Episodes.Select(Num)),
                Num(plan.QualityProfileId),
                plan.RootFolderPath,
                plan.Search ? "1" : "0",
                plan.MinimumAvailability,
                plan.SeriesType ?? string.Empty);
            return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(parts))).ToLowerInvariant();
        }

        private static string? SeriesPath(string? slug) => slug == null ? null : "/series/" + slug;

        private static string EpisodesPath(int seriesId, int seasonNumber) =>
            "/api/v3/episode?seriesId=" + Num(seriesId) + "&seasonNumber=" + Num(seasonNumber);

        private static JsonArray IdArray(IEnumerable<int> ids)
        {
            var array = new JsonArray();
            foreach (var id in ids)
            {
                array.Add(id);
            }

            return array;
        }

        private static List<int> SeasonNumbers(JsonNode? seasons) =>
            (seasons as JsonArray)?.OfType<JsonObject>().Select(s => Int(s["seasonNumber"])).Where(n => n is >= 0 and <= 200).Select(n => n!.Value).Distinct().OrderBy(n => n).ToList()
            ?? new List<int>();

        private static List<ArrEpisode> ParseEpisodes(JsonNode? json) =>
            (json as JsonArray)?.OfType<JsonObject>()
                .Select(e => (Id: PositiveInt(e["id"]), Season: Int(e["seasonNumber"]), Number: Int(e["episodeNumber"]), Monitored: Bool(e["monitored"]) == true))
                .Where(e => e.Id != null && e.Season != null && e.Number != null)
                .Select(e => new ArrEpisode(e.Id!.Value, e.Season!.Value, e.Number!.Value, e.Monitored))
                .ToList()
            ?? new List<ArrEpisode>();

        private static (List<ArrEpisode> Found, List<PlaceholderEpisode> Missing) MatchEpisodes(List<ArrEpisode> list, int seasonNumber, IReadOnlyList<int> wanted)
        {
            var found = new List<ArrEpisode>();
            var missing = new List<PlaceholderEpisode>();
            foreach (var number in wanted)
            {
                var match = list.FirstOrDefault(e => e.Season == seasonNumber && e.Number == number);
                if (match != null)
                {
                    found.Add(match);
                }
                else
                {
                    missing.Add(new PlaceholderEpisode { S = seasonNumber, E = number });
                }
            }

            return (found, missing);
        }

        private static string? Str(JsonNode? node) =>
            node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

        private static string? Text(JsonNode? node, int max, bool cut = false)
        {
            var text = PlaceholderRules.CleanText(Str(node));
            if (text.Length == 0)
            {
                return null;
            }

            if (text.Length > max)
            {
                return cut ? text[..max] : null;
            }

            return text;
        }

        private static int? Int(JsonNode? node)
        {
            if (node is not JsonValue value)
            {
                return null;
            }

            if (value.TryGetValue<int>(out var number))
            {
                return number;
            }

            return value.TryGetValue<double>(out var real) && real >= int.MinValue && real <= int.MaxValue && Math.Abs(real % 1) < double.Epsilon ? (int)real : null;
        }

        private static long? Long(JsonNode? node) =>
            node is JsonValue value && value.TryGetValue<long>(out var number) ? number : null;

        private static int? PositiveInt(JsonNode? node) => Int(node) is > 0 and var n ? n : null;

        private static bool? Bool(JsonNode? node) =>
            node is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;

        private static int? Year(JsonNode? node) => Int(node) is >= 1870 and <= 2100 and var year ? year : null;

        private static string? Imdb(JsonNode? node)
        {
            var text = Str(node)?.Trim().ToLowerInvariant();
            return text != null && ImdbRegex.IsMatch(text) ? text : null;
        }

        private static string? Date(JsonNode? node)
        {
            var text = Str(node);
            if (string.IsNullOrWhiteSpace(text) || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date))
            {
                return null;
            }

            var utc = date.UtcDateTime;
            return utc.Year is >= 1870 and <= 2100 ? utc.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
        }

        private static string? Slug(JsonNode? node)
        {
            var text = Str(node);
            return text != null && SlugRegex.IsMatch(text) ? text : null;
        }

        private static string? Status(JsonNode? node)
        {
            var text = Str(node);
            return text != null && StatusRegex.IsMatch(text) ? text : null;
        }

        private static string? SeriesType(JsonNode? node)
        {
            var text = Str(node);
            return text != null && SeriesTypeNames.Contains(text, StringComparer.Ordinal) ? text : null;
        }

        private static string? PosterUrl(JsonObject hit)
        {
            var url = Str(hit["remotePoster"]);
            if (url == null && hit["images"] is JsonArray images)
            {
                url = images.OfType<JsonObject>().Where(i => Str(i["coverType"]) == "poster").Select(i => Str(i["remoteUrl"])).FirstOrDefault(u => u != null);
            }

            return url != null && url.Length <= 1000 && Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
                ? uri.AbsoluteUri
                : null;
        }

        private static string? TmdbPosterPath(string? posterUrl)
        {
            if (posterUrl == null || !Uri.TryCreate(posterUrl, UriKind.Absolute, out var uri) || !string.Equals(uri.Host, "image.tmdb.org", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            var path = uri.AbsolutePath;
            var file = path[path.LastIndexOf('/')..];
            return PosterFileRegex.IsMatch(file) ? file : null;
        }

        private sealed record AddPlan(
            string Service,
            int InstanceId,
            string? InstanceName,
            string? InstanceKey,
            int? TmdbId,
            int? TvdbId,
            string? ImdbId,
            string Scope,
            int? SeasonNumber,
            IReadOnlyList<int> Episodes,
            int QualityProfileId,
            string RootFolderPath,
            bool Search,
            string MinimumAvailability,
            string? SeriesType,
            string? RequestId);

        private sealed record Target(string Service, int Id, ArrInstance Instance)
        {
            public string Name => DisplayName(Instance, Service);
        }

        private sealed record ArrEpisode(int Id, int Season, int Number, bool Monitored);

        private sealed record ArrResponse(int Status, JsonNode? Json, string? FailureCode)
        {
            public bool Ok => FailureCode == null && Status is >= 200 and < 300;

            public static ArrResponse Fail(string code, int status = 0) => new(status, null, code);
        }
    }
}
