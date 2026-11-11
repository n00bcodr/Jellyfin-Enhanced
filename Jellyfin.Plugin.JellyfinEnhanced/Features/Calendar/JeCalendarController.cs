using System.Collections.Concurrent;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Calendar
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeCalendarController : JeControllerBase
    {
        private readonly Shared.SpoilerGuard.SpoilerSeerrRedactor _spoilerSeerrRedactor;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IItemRepository _itemRepository;
        private readonly IDbContextFactory<JellyfinDbContext> _dbContextFactory;
        private readonly ArrInstanceClient _arrInstanceClient;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly SeerrParentalFilter _parentalFilter;
        private readonly SeerrUserLookup _seerrUserLookup;

        public JeCalendarController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager,
            IItemRepository itemRepository,
            IDbContextFactory<JellyfinDbContext> dbContextFactory,
            Shared.SpoilerGuard.SpoilerSeerrRedactor spoilerSeerrRedactor,
            SeerrParentalFilter parentalFilter)
            : base(userManager, logger, userConfigurationManager)
        {
            _httpClientFactory = httpClientFactory;
            _parentalFilter = parentalFilter;
            _seerrUserLookup = new SeerrUserLookup(httpClientFactory, logger, new UserDisplayResolver(userManager));
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _itemRepository = itemRepository;
            _dbContextFactory = dbContextFactory;
            _spoilerSeerrRedactor = spoilerSeerrRedactor;
            _arrInstanceClient = new ArrInstanceClient(httpClientFactory, logger);
        }

        /// <summary>
        /// Applies the caller's Spoiler Guard to calendar events. Dates stay, because they
        /// are what a calendar is for, and most of these episodes have yet to air.
        /// </summary>
        /// <param name="events">The events built for this response.</param>
        private void RedactCalendarEvents(List<ArrItem> events)
        {
            var guards = _spoilerSeerrRedactor.LoadRows(UserHelper.GetCurrentUserId(User)?.ToString(), HttpContext);
            if (guards == null) return;
            foreach (var calendarEvent in events)
            {
                var tmdbId = calendarEvent.TmdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (calendarEvent.Type == "Movie")
                {
                    var policy = guards.ForTitle(false, tmdbId, null, null);
                    if (policy == null) continue;
                    if (policy.HideOverview) calendarEvent.Overview = null;
                    if (policy.HidePoster) calendarEvent.PosterUrl = null;
                    if (policy.HideBackdrop) calendarEvent.BackdropUrl = null;
                    continue;
                }

                var tvdbId = calendarEvent.TvdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var shokoId = calendarEvent.ShokoSeriesId?.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var itemEpisodeId = calendarEvent.ItemEpisodeId;
                var episodeTvdbId = calendarEvent.EpisodeTvdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (guards.HidesEpisodeOverview(tmdbId, tvdbId, shokoId, itemEpisodeId, episodeTvdbId)) calendarEvent.Overview = null;
                if (!guards.HidesEpisodeTitle(tmdbId, tvdbId, shokoId, itemEpisodeId, episodeTvdbId)) continue;

                var suffix = " - " + calendarEvent.EpisodeTitle;
                if (calendarEvent.Subtitle?.EndsWith(suffix, StringComparison.Ordinal) == true)
                {
                    calendarEvent.Subtitle = calendarEvent.Subtitle.Substring(0, calendarEvent.Subtitle.Length - suffix.Length);
                }

                calendarEvent.EpisodeTitle = null;
            }
        }

        [HttpGet("arr/calendar")]
        [Authorize]
        public async Task<IActionResult> GetCalendarEvents()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            // The caller, read once for every check below. An administrator (same rule as IsAdminUser)
            // gets the answer the settings below never narrowed for them.
            var caller = User;
            var calendarUserId = UserHelper.GetCurrentUserId(caller);
            var calendarUser = calendarUserId.HasValue ? _userManager.GetUserById(calendarUserId.Value) : null;
            var callerIsAdmin = caller.IsInRole("Administrator") || calendarUser?.HasPermission(PermissionKind.IsAdministrator) == true;
            if (!config.CalendarPageEnabled && !callerIsAdmin)
                return NotFound();

            var events = new List<ArrItem>();

            var todayUtc = DateTime.UtcNow.Date;
            DateTime startDate = todayUtc;
            DateTime endDate = todayUtc.AddDays(90);

            if (Request.Query.TryGetValue("start", out var startValues))
            {
                // Invariant: under a culture with another calendar (th-TH is Buddhist) "2026-10-05"
                // would be read as a different year and the range would miss every event.
                if (DateTime.TryParse(startValues.ToString(), System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsedStart))
                {
                    startDate = parsedStart.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedStart, DateTimeKind.Utc) : parsedStart.ToUniversalTime();
                }
            }

            if (Request.Query.TryGetValue("end", out var endValues))
            {
                if (DateTime.TryParse(endValues.ToString(), System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsedEnd))
                {
                    endDate = parsedEnd.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedEnd, DateTimeKind.Utc) : parsedEnd.ToUniversalTime();
                }
            }

            if (endDate < startDate)
            {
                (startDate, endDate) = (endDate, startDate);
            }

            // cap the requested range to prevent an authed
            // user from passing start=1900..end=2099 and triggering 200 years
            // worth of arr-side calendar fetches + dedup loops.
            const int maxCalendarRangeDays = 365;
            var requestedRange = (endDate - startDate).TotalDays;
            if (requestedRange > maxCalendarRangeDays)
            {
                _logger.Info($"Calendar range capped from {(int)requestedRange} days to {maxCalendarRangeDays} days.");
                endDate = startDate.AddDays(maxCalendarRangeDays);
            }

            var startIso = startDate.ToUniversalTime().ToString("o");
            var endIso = endDate.ToUniversalTime().ToString("o");

            DateTime? ParseDate(object? value)
            {
                if (value == null)
                {
                    return null;
                }

                if (value is DateTime dateTimeValue)
                {
                    return dateTimeValue.Kind == DateTimeKind.Unspecified
                        ? DateTime.SpecifyKind(dateTimeValue, DateTimeKind.Utc)
                        : dateTimeValue;
                }

                var asString = Convert.ToString(value);
                if (string.IsNullOrWhiteSpace(asString))
                {
                    return null;
                }

                // Try parsing with invariant culture and assume UTC to avoid local timezone interpretation
                if (DateTime.TryParse(asString, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out var parsed))
                {
                    return parsed;
                }

                // Fallback to regular parsing if above fails
                if (DateTime.TryParse(asString, out parsed))
                {
                    if (parsed.Kind == DateTimeKind.Unspecified)
                    {
                        parsed = DateTime.SpecifyKind(parsed, DateTimeKind.Utc);
                    }
                    return parsed;
                }

                return null;
            }

            void AddRelease(Dictionary<string, DateTime> releases, string type, object? value)
            {
                var parsed = ParseDate(value);
                if (!parsed.HasValue)
                {
                    return;
                }

                if (!releases.TryGetValue(type, out var existing) || parsed.Value < existing)
                {
                    releases[type] = parsed.Value;
                }
            }

            // Fetch calendar events from all configured instances in parallel
            _arrInstanceClient.WarnIfArrInstancesCorrupt(config);
            var sonarrInstances = config.GetEnabledSonarrInstances();
            var radarrInstances = config.GetEnabledRadarrInstances();
            var ct = HttpContext.RequestAborted;

            var sonarrTasks = sonarrInstances.Select(i => FetchSonarrCalendar(i, startIso, endIso, ParseDate, ct)).ToList();
            var radarrTasks = radarrInstances.Select(i => FetchRadarrCalendar(i, startIso, endIso, startDate, endDate, ParseDate, AddRelease, ct)).ToList();

            // Shoko is single-instance (flat ShokoUrl/ShokoApiKey fields, no JSON instance list),
            // so it fans out alongside sonarrTasks/radarrTasks as at most one extra task rather
            // than a per-instance collection. Partial config (only one of URL/key set) surfaces
            // an error without attempting a fetch; both empty means Shoko isn't in use at all —
            // same as zero Sonarr/Radarr instances — and produces no error.
            var shokoUrlSet = !string.IsNullOrWhiteSpace(config.ShokoUrl);
            var shokoKeySet = !string.IsNullOrWhiteSpace(config.ShokoApiKey);
            string? shokoConfigError = (shokoUrlSet != shokoKeySet)
                ? "Shoko URL and API key must both be set"
                : null;
            // Admin-configurable set of AniDB episode types shown on the calendar (Shoko settings).
            var shokoIncludedTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (config.ShokoShowEpisodes) shokoIncludedTypes.Add("Episode");
            if (config.ShokoShowSpecials) shokoIncludedTypes.Add("Special");
            if (config.ShokoShowCredits) shokoIncludedTypes.Add("Credits");
            if (config.ShokoShowTrailers) shokoIncludedTypes.Add("Trailer");
            if (config.ShokoShowParodies) shokoIncludedTypes.Add("Parody");
            if (config.ShokoShowOther) shokoIncludedTypes.Add("Other");

            Task<(List<ArrItem> Items, string? Error)>? shokoTask = config.IsShokoConfigured()
                ? FetchShokoCalendar(
                    new ArrInstance { Name = "Shoko", Url = config.ShokoUrl, ApiKey = config.ShokoApiKey, UrlMappings = config.ShokoUrlMappings ?? "" },
                    startDate, endDate, shokoIncludedTypes, ParseDate, ct)
                : null;

            var sonarrCalResults = await Task.WhenAll(sonarrTasks);
            var radarrCalResults = await Task.WhenAll(radarrTasks);
            var shokoCalResult = shokoTask != null ? await shokoTask : (Items: new List<ArrItem>(), Error: null);

            var errors = new List<object>();
            if (config.IsSonarrInstancesCorrupt())
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "config corrupt — see server logs" });
            else if (sonarrInstances.Count == 0 && config.GetSonarrInstances().Count > 0)
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "all Sonarr instances are disabled" });
            if (config.IsRadarrInstancesCorrupt())
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "config corrupt — see server logs" });
            else if (radarrInstances.Count == 0 && config.GetRadarrInstances().Count > 0)
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "all Radarr instances are disabled" });
            for (int i = 0; i < sonarrCalResults.Length; i++)
            {
                events.AddRange(sonarrCalResults[i].Items);
                if (sonarrCalResults[i].Error != null)
                    errors.Add(new { instanceName = sonarrInstances[i].Name, source = "Sonarr", reason = sonarrCalResults[i].Error });
            }
            for (int i = 0; i < radarrCalResults.Length; i++)
            {
                events.AddRange(radarrCalResults[i].Items);
                if (radarrCalResults[i].Error != null)
                    errors.Add(new { instanceName = radarrInstances[i].Name, source = "Radarr", reason = radarrCalResults[i].Error });
            }
            if (shokoConfigError != null)
                errors.Add(new { instanceName = "Shoko", source = "Shoko", reason = shokoConfigError });
            events.AddRange(shokoCalResult.Items);
            if (shokoCalResult.Error != null)
                errors.Add(new { instanceName = "Shoko", source = "Shoko", reason = shokoCalResult.Error });

            // Resolve ItemIds against Jellyfin's library BEFORE dedup so the dedup tie-breaker can
            // prefer candidates that the current user can actually access (H4). Without this, dedup
            // might pick an instance-B candidate with HasFile=true in a root folder the user can't
            // read, and then the subsequent access filter would hide the event entirely — even
            // though instance-A had the same episode in an accessible root folder.
            var providerKeys = events
                .SelectMany(ProviderHelper.GetAllProviders)
                .Distinct()
                .ToList();

            var itemMap = await _dbContextFactory.GetItemIdsByProvidersBatchAsync(providerKeys, _libraryManager);

            foreach (var evt in events)
            {
                evt.ItemId = ProviderHelper.GetBestItemId(ProviderHelper.GetProviders(evt), itemMap);
                evt.ItemEpisodeId = ProviderHelper.GetBestItemId(ProviderHelper.GetEpisodeProviders(evt), itemMap);
            }

            // Build access info now so the dedup step can consult it.
            HashSet<Guid>? accessibleIds = null;
            Dictionary<string, bool>? rootFolderAccessMap = null;
            if (config.CalendarFilterByLibraryAccess)
            {
                if (calendarUserId.HasValue)
                {
                    var calendarUserForFilter = calendarUser;
                    if (calendarUserForFilter != null)
                    {
                        var uniqueItemIds = events
                            .Select(e => e.ItemId)
                            .Where(id => id.HasValue)
                            .Select(id => id!.Value)
                            .Distinct()
                            .ToList();

                        accessibleIds = new HashSet<Guid>();
                        foreach (var id in uniqueItemIds)
                        {
                            if (_libraryManager.GetItemById<BaseItem>(id, calendarUserForFilter) != null)
                                accessibleIds.Add(id);
                        }

                        rootFolderAccessMap = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
                        foreach (var evt in events.Where(e => e.ItemId.HasValue && !string.IsNullOrEmpty(e.RootFolderPath)))
                        {
                            var isAccessible = accessibleIds.Contains(evt.ItemId!.Value);
                            if (isAccessible || !rootFolderAccessMap.ContainsKey(evt.RootFolderPath!))
                                rootFolderAccessMap[evt.RootFolderPath!] = isAccessible;
                        }
                    }
                }
            }

            // An event with neither a library item nor a root folder known from this answer is unknown:
            // shown only to a caller who sees every library (or an administrator), so a date window
            // holding only not-yet-downloaded titles cannot reveal a restricted folder's.
            var unknownIsAccessible = callerIsAdmin || calendarUser?.HasPermission(PermissionKind.EnableAllFolders) == true;

            // Returns true when the filter is off, or when we have positive evidence the user can
            // access this event. "No information" follows unknownIsAccessible (same as the final filter).
            bool IsAccessible(ArrItem evt)
            {
                if (accessibleIds == null) return true;
                if (evt.ItemId.HasValue)
                    return accessibleIds.Contains(evt.ItemId.Value);
                if (!string.IsNullOrEmpty(evt.RootFolderPath)
                    && rootFolderAccessMap != null
                    && rootFolderAccessMap.TryGetValue(evt.RootFolderPath, out var a))
                    return a;
                return unknownIsAccessible;
            }

            // Deduplicate events across instances. Tie-break priority:
            //   1. Accessible to the current user (prevents H4 hide-accessible-event bug).
            //   2. HasFile=true (if one instance has the file downloaded, show that).
            // The losing candidate's InstanceName is preserved in AlsoInInstances so the UI
            // can show "also in: X, Y" context instead of silently erasing other instances.
            // normalize ReleaseDate to a calendar-day
            // bucket before using it in the dedup key. Different Sonarr/Radarr
            // versions emit different precision (`...000Z` vs `Z`, airDate vs
            // airDateUtc fallbacks with TZ drift); using the raw string fails
            // dedup and surfaces duplicate events on a per-instance basis.
            static string NormalizeDateForDedup(string? raw)
            {
                if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
                if (DateTimeOffset.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                        out var dto))
                {
                    return dto.UtcDateTime.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
                }
                // Fallback: strip everything after the first 10 chars when it
                // already looks like an ISO date prefix.
                return raw.Length >= 10 ? raw.Substring(0, 10) : raw;
            }

            var deduped = new Dictionary<string, ArrItem>();
            foreach (var evt in events)
            {
                string dedupeKey;
                var normalizedDate = NormalizeDateForDedup(evt.ReleaseDate);
                if (evt.Source == nameof(ArrType.Sonarr))
                {
                    var seriesKey = evt.TvdbId?.ToString() ?? $"title:{evt.Title}";
                    dedupeKey = $"sonarr|{seriesKey}|S{evt.SeasonNumber}E{evt.EpisodeNumber}|{normalizedDate}";
                }
                else if (evt.Source == nameof(ArrType.Shoko))
                {
                    // Never cross-matched against sonarr|/radarr| keys.
                    dedupeKey = $"shoko|{evt.ShokoSeriesId}|{evt.ShokoEpisodeId}|{normalizedDate}";
                }
                else
                {
                    var movieKey = evt.TmdbId?.ToString() ?? $"title:{evt.Title}";
                    dedupeKey = $"radarr|{movieKey}|{evt.ReleaseType}|{normalizedDate}";
                }

                if (!deduped.TryGetValue(dedupeKey, out var existing))
                {
                    deduped[dedupeKey] = evt;
                    continue;
                }

                var existingAccess = IsAccessible(existing);
                var newAccess = IsAccessible(evt);
                ArrItem winner, loser;
                if (newAccess && !existingAccess)
                {
                    winner = evt; loser = existing;
                }
                else if (newAccess == existingAccess && !existing.HasFile && evt.HasFile)
                {
                    winner = evt; loser = existing;
                }
                else
                {
                    winner = existing; loser = evt;
                }

                if (!ReferenceEquals(winner, existing))
                {
                    deduped[dedupeKey] = winner;
                }

                // Merge loser's instance name into winner's AlsoInInstances (dedup & skip self).
                if (!string.IsNullOrEmpty(loser.InstanceName)
                    && !string.Equals(loser.InstanceName, winner.InstanceName, StringComparison.Ordinal))
                {
                    winner.AlsoInInstances ??= new List<string>();
                    if (!winner.AlsoInInstances.Contains(loser.InstanceName))
                        winner.AlsoInInstances.Add(loser.InstanceName);
                }
                // Preserve loser's own AlsoInInstances entries too.
                if (loser.AlsoInInstances != null)
                {
                    winner.AlsoInInstances ??= new List<string>();
                    foreach (var name in loser.AlsoInInstances)
                    {
                        if (!string.Equals(name, winner.InstanceName, StringComparison.Ordinal)
                            && !winner.AlsoInInstances.Contains(name))
                            winner.AlsoInInstances.Add(name);
                    }
                }
            }
            events = deduped.Values.ToList();

            // Final safety-net access filter (defense in depth — dedup above already respects this,
            // but if the filter is on and a lone candidate is inaccessible, it must still be hidden).
            if (config.CalendarFilterByLibraryAccess && accessibleIds != null)
            {
                events = events.Where(e =>
                {
                    if (e.ItemId.HasValue)
                        return accessibleIds.Contains(e.ItemId.Value);
                    if (!string.IsNullOrEmpty(e.RootFolderPath)
                        && rootFolderAccessMap != null
                        && rootFolderAccessMap.TryGetValue(e.RootFolderPath, out var hasAccess))
                        return hasAccess;
                    return unknownIsAccessible;
                }).ToList();
            }

            if (!callerIsAdmin)
            {
                static (string MediaType, int TmdbId)? TitleKey(ArrItem e)
                    => e.TmdbId is int id ? (e.Type == "Series" ? "tv" : "movie", id) : null;

                // "Force Only Requested Items": the caller's own Seerr requests only. Unknown is not
                // "none requested": a failed lookup shows nothing and says so.
                if (config.CalendarForceOnlyRequested)
                {
                    var requested = await GetRequestedTitlesAsync(config, calendarUserId?.ToString(), ct);
                    if (requested == null)
                        errors.Add(new { instanceName = "Seerr", source = "Seerr", reason = "your requests could not be loaded" });
                    events = events.Where(e => TitleKey(e) is { } key && requested?.Contains(key) == true).ToList();
                }

                // The caller's parental limit, as the Seerr routes apply it, for every title Jellyfin has
                // not already checked for this caller through the library filter. Unchecked is hidden.
                var callerIdText = calendarUserId?.ToString();
                if (_parentalFilter.TryGetRestrictedPolicy(callerIdText, out _))
                {
                    bool CheckedByLibrary(ArrItem e) => accessibleIds != null && e.ItemId.HasValue;
                    var titles = events.Where(e => !CheckedByLibrary(e)).Select(TitleKey).OfType<(string MediaType, int TmdbId)>().Distinct().ToList();
                    var allowed = new ConcurrentDictionary<(string MediaType, int TmdbId), bool>();
                    using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    budget.CancelAfter(TimeSpan.FromSeconds(12));
                    try
                    {
                        await Parallel.ForEachAsync(titles, new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = budget.Token }, async (title, token) =>
                            allowed[title] = !await _parentalFilter.IsBlockedAsync(title.MediaType, title.TmdbId, callerIdText, token));
                    }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    {
                        // Over budget: titles not checked yet stay hidden.
                    }

                    events = events.Where(e => CheckedByLibrary(e) || (TitleKey(e) is { } key && allowed.TryGetValue(key, out var ok) && ok)).ToList();
                }
            }

            RedactCalendarEvents(events);
            return Ok(new { events, errors });
        }

        /// <summary>
        /// The titles the caller requested in Seerr, as ("movie"|"tv", TMDB id): none when Seerr is
        /// off (as the page treats it), null when they could not be read (Seerr unreachable or
        /// failing, caller not linked to a Seerr user).
        /// </summary>
        private async Task<HashSet<(string MediaType, int TmdbId)>?> GetRequestedTitlesAsync(Configuration.PluginConfiguration config, string? jellyfinUserId, CancellationToken ct)
        {
            if (!config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
                return new HashSet<(string MediaType, int TmdbId)>();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return null;
            var seerrUserId = await _seerrUserLookup.GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(seerrUserId))
                return null;

            var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
            client.Timeout = TimeSpan.FromSeconds(15);
            foreach (var url in config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var baseUrl = url.Trim().TrimEnd('/');
                try
                {
                    var titles = new HashSet<(string MediaType, int TmdbId)>();
                    const int pageSize = 200;
                    for (var skip = 0; ; skip += pageSize)
                    {
                        var requestUri = $"{baseUrl}/api/v1/request?take={pageSize}&skip={skip}&requestedBy={Uri.EscapeDataString(seerrUserId)}";
                        using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                        using var response = await client.SendAsync(request, ct);
                        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri, ct);
                        if (json == null)
                            throw new HttpRequestException(error?.Message ?? "no answer");
                        using var doc = JsonDocument.Parse(json);
                        var results = doc.RootElement.GetProperty("results");
                        foreach (var row in results.EnumerateArray())
                        {
                            var type = row.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
                            if ((type is "movie" or "tv") && row.TryGetProperty("media", out var media) && media.ValueKind == JsonValueKind.Object
                                && media.TryGetProperty("tmdbId", out var idEl) && idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt32(out var tmdbId))
                                titles.Add((type, tmdbId));
                        }
                        if (results.GetArrayLength() < pageSize)
                            return titles;
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Calendar: could not read Seerr requests from {baseUrl}: {ex.Message}");
                }
            }
            return null;
        }

        private Task<(List<ArrItem> Items, string? Error)> FetchSonarrCalendar(
            ArrInstance instance, string startIso, string endIso,
            Func<object?, DateTime?> parseDate, CancellationToken ct)
        {
            return _arrInstanceClient.FetchAndMapAsync<List<ArrItem>>(
                instance,
                $"/api/v3/calendar?includeSeries=true&unmonitored=true&start={startIso}&end={endIso}",
                data =>
                {
                    var items = new List<ArrItem>();
                    if (data == null) return items;
                    foreach (var episode in data)
                    {
                        var airDate = parseDate((string?)episode.airDateUtc ?? (string?)episode.airDate);
                        if (!airDate.HasValue) continue;

                        string? seriesPosterUrl = null;
                        string? seriesBackdropUrl = null;
                        if (episode.series?.images != null)
                        {
                            foreach (var img in episode.series.images)
                            {
                                var coverType = (string?)img.coverType;
                                var imageUrl = (string?)img.remoteUrl ?? (string?)img.url;
                                if (string.IsNullOrWhiteSpace(imageUrl)) continue;
                                if (seriesBackdropUrl == null && (coverType == "fanart" || coverType == "banner"))
                                    seriesBackdropUrl = imageUrl;
                                else if (seriesPosterUrl == null && coverType == "poster")
                                    seriesPosterUrl = imageUrl;
                            }
                        }

                        var seasonNumber = (int?)episode.seasonNumber ?? 0;
                        var episodeNumber = (int?)episode.episodeNumber ?? 0;
                        var episodeTitle = (string?)episode.title ?? "Unknown Episode";

                        items.Add(new ArrItem
                        {
                            Id = (string?)episode.id?.ToString(),
                            Source = nameof(ArrType.Sonarr),
                            InstanceName = instance.Name,
                            Type = "Series",
                            Title = (string?)episode.series?.title ?? "Unknown Series",
                            Subtitle = $"S{seasonNumber:D2}E{episodeNumber:D2} - {episodeTitle}",
                            ReleaseDate = airDate.Value.ToUniversalTime().ToString("o"),
                            ReleaseType = "Episode",
                            HasFile = (bool?)episode.hasFile ?? false,
                            Monitored = (bool?)episode.monitored ?? false,
                            SeriesId = (int?)episode.seriesId,
                            SeasonNumber = seasonNumber,
                            EpisodeNumber = episodeNumber,
                            EpisodeTitle = episodeTitle,
                            FinaleType = (string?)episode.finaleType,
                            Overview = (string?)episode.overview,
                            TvdbId = (int?)episode.series?.tvdbId,
                            ImdbId = (string?)episode.series?.imdbId,
                            TmdbId = (int?)episode.series?.tmdbId,
                            PosterUrl = seriesPosterUrl,
                            BackdropUrl = seriesBackdropUrl,
                            EpisodeTvdbId = (int?)episode.tvdbId,
                            EpisodeImdbId = (string?)episode.imdbId,
                            RootFolderPath = ArrInstanceClient.GetRootFolderFromPath((string?)episode.series?.path)
                        });
                    }
                    return items;
                },
                emptyResult: new List<ArrItem>(),
                // aligned with Radarr (15s) — was 30s, which doubled
                // the worst-case calendar latency under one slow instance.
                timeout: TimeSpan.FromSeconds(15),
                contextLabel: "Sonarr calendar",
                ct: ct);
        }

        private Task<(List<ArrItem> Items, string? Error)> FetchRadarrCalendar(
            ArrInstance instance, string startIso, string endIso,
            DateTime startDate, DateTime endDate,
            Func<object?, DateTime?> parseDate,
            Action<Dictionary<string, DateTime>, string, object?> addRelease,
            CancellationToken ct)
        {
            return _arrInstanceClient.FetchAndMapAsync<List<ArrItem>>(
                instance,
                $"/api/v3/calendar?unmonitored=true&start={startIso}&end={endIso}",
                data =>
                {
                    var items = new List<ArrItem>();
                    if (data == null) return items;
                    foreach (var movie in data)
                    {
                        var releaseDates = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

                        string? posterUrl = null;
                        string? backdropUrl = null;
                        if (movie.images != null)
                        {
                            foreach (var img in movie.images)
                            {
                                var coverType = (string?)img.coverType;
                                var imageUrl = (string?)img.remoteUrl ?? (string?)img.url;
                                if (string.IsNullOrWhiteSpace(imageUrl)) continue;
                                if (posterUrl == null && coverType == "poster") { posterUrl = imageUrl; continue; }
                                if (backdropUrl == null && (coverType == "fanart" || coverType == "backdrop"))
                                    backdropUrl = imageUrl;
                            }
                        }

                        addRelease(releaseDates, "CinemaRelease", (string?)movie.inCinemas);
                        addRelease(releaseDates, "PhysicalRelease", (string?)movie.physicalRelease);
                        addRelease(releaseDates, "DigitalRelease", (string?)movie.digitalRelease);

                        if (movie.releases != null)
                        {
                            foreach (var release in movie.releases)
                            {
                                var releaseDate = (object?)release.releaseDate ?? release.date;
                                var type = Convert.ToString(release.type)?.ToLowerInvariant();
                                var isPhysical = (bool?)release.isPhysical ?? false;
                                if (isPhysical) addRelease(releaseDates, "PhysicalRelease", releaseDate);
                                else if (type == "digital") addRelease(releaseDates, "DigitalRelease", releaseDate);
                                else if (type == "theatrical" || type == "cinema" || type == "theater")
                                    addRelease(releaseDates, "CinemaRelease", releaseDate);
                            }
                        }

                        if (releaseDates.Count == 0) continue;

                        var movieTitle = (string?)movie.title ?? (string?)movie.originalTitle ?? "Unknown";
                        string? movieYear = null;
                        var yearValue = (object?)movie.year;
                        if (yearValue != null) movieYear = Convert.ToString(yearValue);

                        foreach (var kvp in releaseDates)
                        {
                            var releaseUtc = kvp.Value.ToUniversalTime();
                            if (releaseUtc < startDate || releaseUtc > endDate) continue;
                            items.Add(new ArrItem
                            {
                                Id = $"{movie.id}-{kvp.Key}",
                                Source = nameof(ArrType.Radarr),
                                InstanceName = instance.Name,
                                Type = "Movie",
                                Title = movieTitle,
                                Subtitle = movieYear,
                                ReleaseDate = releaseUtc.ToString("o"),
                                ReleaseType = kvp.Key,
                                HasFile = (bool?)movie.hasFile ?? false,
                                Monitored = (bool?)movie.monitored ?? false,
                                PosterUrl = posterUrl,
                                BackdropUrl = backdropUrl,
                                TmdbId = (int?)movie.tmdbId,
                                ImdbId = (string?)movie.imdbId,
                                RootFolderPath = ArrInstanceClient.GetRootFolderFromPath((string?)movie.path)
                            });
                        }
                    }
                    return items;
                },
                emptyResult: new List<ArrItem>(),
                // aligned with Sonarr (15s) — was 10s, which timed
                // out busy Radarr instances behind slow proxies.
                timeout: TimeSpan.FromSeconds(15),
                contextLabel: "Radarr calendar",
                ct: ct);
        }

        private Task<(List<ArrItem> Items, string? Error)> FetchShokoCalendar(
            ArrInstance instance, DateTime startDate, DateTime endDate,
            HashSet<string> includedTypes, Func<object?, DateTime?> parseDate, CancellationToken ct)
        {
            var startParam = startDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            var endParam = endDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            return _arrInstanceClient.FetchAndMapAsync<List<ArrItem>>(
                instance,
                $"/api/v3/Dashboard/CalendarEpisodes?startDate={startParam}&endDate={endParam}&includeMissing=false&includeRestricted=false",
                data =>
                {
                    var items = new List<ArrItem>();
                    if (data == null) return items;
                    foreach (var episode in data)
                    {
                        // Which AniDB episode types to show is admin-configurable (Shoko settings).
                        var episodeType = (string?)episode.Type;
                        if (episodeType == null || !includedTypes.Contains(episodeType)) continue;

                        var airDate = parseDate((string?)episode.AirDate);
                        if (!airDate.HasValue) continue;

                        int? shokoSeriesId = episode.IDs?.ShokoSeries;
                        int? shokoEpisodeId = episode.IDs?.ShokoEpisode;
                        int? shokoFileId = episode.IDs?.ShokoFile;
                        var seriesTitle = (string?)episode.SeriesTitle ?? "Unknown Series";
                        var episodeTitle = (string?)episode.Title ?? "Unknown Episode";
                        var episodeNumber = (int?)episode.Number ?? 0;

                        items.Add(new ArrItem
                        {
                            Id = shokoEpisodeId?.ToString() ?? $"shoko-{shokoSeriesId}-{episodeType}-{episodeNumber}",
                            Source = nameof(ArrType.Shoko),
                            InstanceName = "Shoko",
                            Type = "Series",
                            Title = seriesTitle,
                            EpisodeTitle = episodeTitle,
                            Subtitle = $"{episodeType} {episodeNumber} - {episodeTitle}",
                            ReleaseDate = airDate.Value.ToUniversalTime().ToString("o"),
                            ReleaseType = "Anime",
                            HasFile = shokoFileId.HasValue,
                            Monitored = true,
                            SeasonNumber = null,
                            EpisodeNumber = episodeNumber,
                            ShokoSeriesId = shokoSeriesId,
                            ShokoEpisodeId = shokoEpisodeId,
                            RootFolderPath = null
                        });
                    }
                    return items;
                },
                emptyResult: new List<ArrItem>(),
                timeout: TimeSpan.FromSeconds(15),
                contextLabel: "Shoko calendar",
                authHeaderName: "apikey",
                ct: ct);
        }

        [HttpPost("arr/calendar/user-data")]
        [Authorize]
        public IActionResult GetCalendarUserDataForEvents([FromBody] CalendarUserDataRequest request)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null)
                return Unauthorized("User not found");

            var user = _userManager.GetUserById(userId.Value);
            if (user == null)
                return Unauthorized("User not found");

            var results = new List<object>();

            try
            {
                if (request?.Events == null || request.Events.Count == 0)
                    return Ok(new { results });

                var ids = request.Events
                    .SelectMany(e => new Guid?[] { e.ItemId, e.ItemEpisodeId })
                    .Where(id => id.HasValue)
                    .Select(id => id!.Value)
                    .Distinct()
                    .ToList();

                var itemsById = new Dictionary<Guid, BaseItem>();
                if (ids.Count > 0)
                {
                    var items = _libraryManager.GetItemList(new InternalItemsQuery
                    {
                        User = user,
                        ItemIds = ids.ToArray(),
                        Recursive = true
                    });

                    foreach (var item in items)
                    {
                        if (!itemsById.ContainsKey(item.Id))
                            itemsById[item.Id] = item;
                    }
                }

                // Process each event using pre-fetched items
                foreach (var evt in request.Events)
                {
                    bool isFavorite = false;
                    bool isWatched = false;

                    BaseItem? item = null;
                    BaseItem? episodeItem = null;

                    if (evt.ItemId.HasValue)
                        itemsById.TryGetValue(evt.ItemId.Value, out item);
                    if (evt.ItemEpisodeId.HasValue)
                        itemsById.TryGetValue(evt.ItemEpisodeId.Value, out episodeItem);

                    if (item != null)
                    {
                        var itemData = _userDataManager.GetUserData(user, item);
                        isFavorite = itemData?.Likes == true;

                        if (evt.Type == "Movie")
                        {
                            isWatched = itemData?.Played == true || (itemData?.PlaybackPositionTicks ?? 0) > 0;
                        }
                    }

                    if (evt.Type == "Series" && episodeItem != null)
                    {
                        var epData = _userDataManager.GetUserData(user, episodeItem);
                        isWatched = epData?.Played == true || (epData?.PlaybackPositionTicks ?? 0) > 0;
                    }

                    results.Add(new
                    {
                        id = evt.Id,
                        isFavorite,
                        isWatched
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to get calendar user data: {ex.Message}");
            }

            return Ok(new { results });
        }

        public class CalendarUserDataRequest
        {
            public List<CalendarEventInfo> Events { get; set; } = new();
        }

        public class CalendarEventInfo
        {
            public string? Id { get; set; }
            public string? Type { get; set; }
            public string? Title { get; set; }
            public Guid? ItemId { get; set; }
            public Guid? ItemEpisodeId { get; set; }
            public int? TvdbId { get; set; }
            public string? ImdbId { get; set; }
            public int? TmdbId { get; set; }
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
        }

        [Authorize]
        [HttpGet("items/by-providers")]
        public ActionResult<Guid?> GetItemIdByProviders(
            [FromQuery] Dictionary<string, string>? providers,
            [FromQuery] string? types = null)
        {
            List<BaseItemKind>? includeItemTypes = null;
            if (!string.IsNullOrWhiteSpace(types))
            {
                includeItemTypes = types
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(t => Enum.TryParse<BaseItemKind>(t, true, out var kind) ? kind : (BaseItemKind?)null)
                    .Where(k => k.HasValue)
                    .Select(k => k!.Value)
                    .ToList();
            }

            var itemIds = _itemRepository.GetItemIdsByProviders(providers, includeItemTypes);
            if (!IsAdminUser())
            {
                // Only an item the caller may see, as Jellyfin's own item routes decide; administrators as before.
                var userId = UserHelper.GetCurrentUserId(User);
                var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
                itemIds = itemIds.Where(id => user != null && _libraryManager.GetItemById<BaseItem>(id, user) != null).Take(1).ToList();
            }

            if (itemIds.Count == 0)
                return BadRequest("No provider ids supplied or no items found");

            return Ok(itemIds.FirstOrDefault());
        }
    }
}
