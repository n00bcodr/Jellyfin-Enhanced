using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// "Jellyfin Enhanced" request mode: sends approved requests straight to Sonarr or Radarr.
    /// <list type="bullet">
    /// <item><description>Only the instance the job was authorised for, at the same connection generation; a 4K job only ever
    /// goes to a 4K-role instance (never the standard one).</description></item>
    /// <item><description>Read before write: the title is looked up fresh in the arr; a lookup row must carry the requested id
    /// (greater than zero). A title the arr already has is a merge: only the missing monitoring is switched on.</description></item>
    /// <item><description>New titles get the instance's add defaults (profile, root folder, tags), checked against a current
    /// system snapshot only when a title is added; existing ones are changed with field-scoped edits only (<c>movie/editor</c>,
    /// <c>series/editor</c>, <c>seasonpass</c>, <c>episode/monitor</c>), never a full-resource PUT, so monitoring
    /// the request doesn't cover stays as it was.</description></item>
    /// <item><description>The guard runs before the first call and again before every write and search, the last time right
    /// before the call leaves (after any wait for a free connection slot).</description></item>
    /// <item><description>Searches after the add; the result counts only once the search was accepted and a fresh read shows
    /// exactly what was asked for. A write whose answer was lost is "maybe sent" and is settled by that read, never by
    /// sending blindly again: nothing there is safe to send again; anything there (an add, part of the monitoring, or
    /// all of it with the search unknown) is completed by a fresh send while it can't be cancelled or refunded.</description></item>
    /// </list>
    /// </summary>
    public sealed class DirectArrBackend : IRequestBackend
    {
        /// <summary>How long a new series' episode list is waited for before monitoring single episodes.</summary>
        internal static readonly TimeSpan EpisodeWait = TimeSpan.FromSeconds(20);

        private readonly ArrClientFactory _clients;
        private readonly ArrStateStore _store;
        private readonly TitleAliases? _aliases;
        private readonly Func<TimeSpan, CancellationToken, Task> _delay;

        /// <summary>Creates the executor (DI).</summary>
        public DirectArrBackend(ArrClientFactory clients, ArrStateStore store, TitleAliases aliases)
            : this(clients, store, aliases, null)
        {
        }

        /// <summary>Creates the executor with an explicit delay (tests).</summary>
        internal DirectArrBackend(ArrClientFactory clients, ArrStateStore store, TitleAliases? aliases, Func<TimeSpan, CancellationToken, Task>? delay)
        {
            _clients = clients;
            _store = store;
            _aliases = aliases;
            _delay = delay ?? ((t, ct) => Task.Delay(t, ct));
        }

        /// <inheritdoc />
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;

        /// <inheritdoc />
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();

        /// <inheritdoc />
        public async Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
        {
            // The guard runs before any upstream contact, and again right before every write and search.
            if (finalGuard() is { } refusal) return RequestBackendResult.Hold(refusal);
            var key = TitleKey.Parse(job.Input.Key);
            if (key == null || key.Season.HasValue) return BackendResults.Failed("invalid_input", "The request's title key is not a movie or series key.");
            if (Target(job, key, out var hold) is not { } target) return hold!;
            var (instance, client) = target;
            var run = new Run(job, instance, client, key, finalGuard, ct);
            return key.IsMovie ? await MovieAsync(run).ConfigureAwait(false) : await SeriesAsync(run).ConfigureAwait(false);
        }

        /// <inheritdoc />
        public async Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct)
        {
            var key = TitleKey.Parse(job.Input.Key);
            if (key == null) return BackendResults.Maybe(job.WantId, "The request's title key can't be read back.", "invalid_input");
            // Read-back uses the original connection: a changed URL or key can't prove anything about it.
            var instance = _clients.Registry.Get(job.Authorization.InstanceId);
            if (instance == null || _clients.ConnectionGeneration(instance.Id) != job.Authorization.ConnectionGeneration)
                return BackendResults.Maybe(job.WantId, "The instance this request was sent to has changed since; check it there.", "instance_changed");
            var client = _clients.For(instance.Id, allowUnusable: true);
            if (!client.Ok) return BackendResults.Maybe(job.WantId, "The instance can't be read right now.", "service_down");
            var verify = await VerifyAsync(client.Value!, job.Input, key, ct).ConfigureAwait(false);
            if (verify.Matched == null) return BackendResults.Maybe(job.WantId, verify.Message, "service_down");
            // The title isn't there: nothing of this request is, so sending again is safe (every step reads before it writes).
            if (!verify.Present) return BackendResults.NotThere(verify.Message);
            // The title is there: the add or part of the monitoring landed, and whether the search started can't be
            // read back. The next attempt completes it with a fresh, guarded send that writes only what is missing.
            return BackendResults.Resume(job.WantId, verify.Matched == true
                ? $"{instance.Name} has the change; the search is sent again to be sure."
                : $"{instance.Name} has part of the change ({verify.Message}); the rest is sent on the next attempt.");
        }

        private readonly record struct Run(RequestJob Job, ArrConnection Instance, ArrClient Client, TitleKey Key, Func<string?> Guard, CancellationToken Ct);

        // The add settings, checked against a current system snapshot. Only an add needs them: merges are
        // field-scoped monitoring edits that never send a profile, folder or tag.
        private async Task<(ArrAddDefaults? Defaults, RequestBackendResult? Stop)> DefaultsAsync(Run run)
        {
            var system = await ArrAddRules.FreshSystemAsync(_store, run.Instance, run.Ct).ConfigureAwait(false);
            IReadOnlyDictionary<int, string>? tags = null;
            if (run.Instance.Defaults?.Tags is { Count: > 0 })
            {
                var read = await run.Client.GetAsync<List<TagRow>>("tag", null, ArrCallClass.Read, run.Ct).ConfigureAwait(false);
                if (read.Ok) tags = read.Value!.GroupBy(t => t.Id).ToDictionary(g => g.Key, g => g.First().Label ?? string.Empty);
            }
            var check = ArrAddRules.Check(run.Instance, system, tags, run.Job.Input.ProfileId, run.Job.Input.RootFolder);
            if (check.Defaults != null) return (check.Defaults, null);
            return (null, check.Reason == "defaults_unverified" ? BackendResults.Retry("backend_unavailable", check.Message) : BackendResults.Hold("invalid_defaults", check.Message));
        }

        // The guard before a write or a search. Refused before anything was written: held, nothing sent.
        // Refused after a write: held too, with the certainty left unknown (the written part stays upstream).
        private static RequestBackendResult? Gate(Run run, bool wrote)
            => run.Guard() is { } refusal ? Refused(run, wrote, refusal) : null;

        private static RequestBackendResult Refused(Run run, bool wrote, string refusal)
            => wrote
                ? BackendResults.HoldAfterWrite(run.Job.WantId, refusal, $"{run.Instance.Name} has part of the change; the rest was stopped ({refusal}).")
                : RequestBackendResult.Hold(refusal);

        // A write or search. The guard is asked once more after the client's wait for a free connection slot, right
        // before the call leaves (slow calls can hold every slot for a while): refused there, this call sends nothing.
        // wrote: whether an earlier step of this attempt wrote.
        private static async Task<(ArrResult<T> Result, RequestBackendResult? Stop)> WriteAsync<T>(Run run, bool wrote, HttpMethod method, string path, object body)
        {
            string? refusal = null;
            var result = await run.Client.SendCheckedAsync<T>(method, path, body, () => (refusal = run.Guard()) == null, run.Ct).ConfigureAwait(false);
            return (result, refusal == null ? null : Refused(run, wrote, refusal));
        }

        // A search that didn't start: the request isn't done until it has. After a write (or with a lost answer) the
        // change is upstream, so the request resumes; otherwise nothing was sent and it is simply tried again.
        private static RequestBackendResult SearchFailure(Run run, bool wrote, ArrError error)
        {
            if (wrote || error.MaybeSent || error.Kind == ArrErrorKind.Server)
                return BackendResults.Resume(run.Job.WantId, $"{run.Instance.Name} has the change but the search didn't start ({error.Message}); it is sent again.");
            return error.Kind == ArrErrorKind.Unauthorized
                ? BackendResults.Hold("service_down", $"{run.Instance.Name} rejected the API key.")
                : BackendResults.Retry("backend_unavailable", $"{run.Instance.Name} didn't start the search: {error.Message}");
        }

        // The instance the job was authorised for, at the same generation, of the right kind and edition.
        private (ArrConnection Instance, ArrClient Client)? Target(RequestJob job, TitleKey key, out RequestBackendResult? refusal)
        {
            refusal = null;
            var instance = _clients.Registry.Get(job.Authorization.InstanceId);
            var kind = key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr;
            if (instance == null || !instance.Usable || instance.Kind != kind
                || (instance.Role == ArrInstanceRole.FourK) != (job.Input.Variant == "4k")
                || (job.Input.InstanceId != null && !string.Equals(job.Input.InstanceId, instance.Id, StringComparison.OrdinalIgnoreCase)))
            {
                refusal = BackendResults.Hold("instance_changed", job.Input.Variant == "4k"
                    ? "No usable 4K instance matches this request any more; 4K requests never go to a standard instance."
                    : "The instance this request was approved for is gone, disabled or no longer of this kind.");
                return null;
            }
            if (_clients.ConnectionGeneration(instance.Id) != job.Authorization.ConnectionGeneration)
            {
                refusal = BackendResults.Hold("instance_changed", $"{instance.Name}'s address or API key changed after this request was approved.");
                return null;
            }
            var client = _clients.For(instance.Id);
            if (!client.Ok)
            {
                refusal = BackendResults.Retry("backend_unavailable", $"{instance.Name} can't be used right now: {client.Error!.Message}");
                return null;
            }
            return (instance, client.Value!);
        }

        // ---------------- movies ----------------

        private async Task<RequestBackendResult> MovieAsync(Run run)
        {
            var (job, instance, client, key, ct) = (run.Job, run.Instance, run.Client, run.Key, run.Ct);
            var existing = await FindMovieAsync(client, key, ct).ConfigureAwait(false);
            if (existing.Error != null) return ReadFailure(instance, existing.Error);
            var movie = existing.Movie;
            var merged = movie != null;
            var wrote = false;
            if (movie == null)
            {
                var lookup = await LookupAsync(client, key, ct).ConfigureAwait(false);
                if (lookup.Error != null) return ReadFailure(instance, lookup.Error);
                if (lookup.Row is not { } row) return BackendResults.Hold("title_not_found", $"{instance.Name} couldn't find this title by its id.");
                if (Int(row, "id") is int arrId && arrId > 0)
                {
                    // Added meanwhile (another writer): a merge.
                    var current = await client.GetAsync<JsonElement>("movie/" + arrId.ToString(CultureInfo.InvariantCulture), null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    if (!current.Ok) return ReadFailure(instance, current.Error!);
                    movie = current.Value;
                    merged = true;
                }
                else
                {
                    var (defaults, stop) = await DefaultsAsync(run).ConfigureAwait(false);
                    if (defaults == null) return stop!;
                    if (Gate(run, wrote) is { } refused) return refused;
                    var body = (JsonObject)JsonNode.Parse(row.GetRawText())!;
                    body.Remove("id");
                    body["qualityProfileId"] = defaults.ProfileId;
                    body["rootFolderPath"] = defaults.RootFolder;
                    body["monitored"] = true;
                    body["minimumAvailability"] = defaults.MinimumAvailability;
                    body["tags"] = new JsonArray(defaults.Tags.Select(t => (JsonNode)t).ToArray());
                    body["addOptions"] = new JsonObject { ["searchForMovie"] = true, ["monitor"] = "movieOnly", ["addMethod"] = "manual" };
                    var (added, stopped) = await WriteAsync<JsonElement>(run, false, HttpMethod.Post, "movie", body).ConfigureAwait(false);
                    if (stopped != null) return stopped;
                    wrote = true;
                    if (added.Ok)
                    {
                        movie = added.Value;
                    }
                    else if (AlreadyAdded(added.Error!))
                    {
                        var again = await FindMovieAsync(client, key, ct).ConfigureAwait(false);
                        if (again.Movie == null) return BackendResults.Maybe(job.WantId, $"{instance.Name} said the movie is already added, but it couldn't be read back.");
                        movie = again.Movie;
                        merged = true;
                    }
                    else
                    {
                        return WriteFailure(job, instance, added.Error!);
                    }
                }
            }
            if (merged && movie is { } have)
            {
                var id = Int(have, "id") ?? 0;
                if (Bool(have, "monitored") != true)
                {
                    if (Gate(run, wrote) is { } refused) return refused;
                    var partial = wrote;
                    wrote = true;
                    var (edit, stopped) = await WriteAsync<NoContent>(run, partial, HttpMethod.Put, "movie/editor", new { movieIds = new[] { id }, monitored = true }).ConfigureAwait(false);
                    if (stopped != null) return stopped;
                    if (!edit.Ok) return WriteFailure(job, instance, edit.Error!, partial);
                }
                if (Bool(have, "hasFile") != true)
                {
                    if (Gate(run, wrote) is { } refused) return refused;
                    var before = wrote;
                    wrote = true;
                    var (search, stopped) = await WriteAsync<NoContent>(run, before, HttpMethod.Post, "command", new { name = "MoviesSearch", movieIds = new[] { id } }).ConfigureAwait(false);
                    if (stopped != null) return stopped;
                    if (!search.Ok) return SearchFailure(run, before, search.Error!);
                }
            }
            return await ConfirmAsync(run, merged).ConfigureAwait(false);
        }

        // The library entry for a movie key: by TMDB id (a cheap filtered read), else through a lookup row's id.
        private async Task<(JsonElement? Movie, ArrError? Error)> FindMovieAsync(ArrClient client, TitleKey key, CancellationToken ct)
        {
            var tmdb = TmdbOf(key);
            if (tmdb is > 0)
            {
                var read = await client.GetAsync<List<JsonElement>>("movie", Query("tmdbId", tmdb.Value), ArrCallClass.Read, ct).ConfigureAwait(false);
                if (!read.Ok) return (null, read.Error);
                return (read.Value!.Where(m => Int(m, "tmdbId") == tmdb).Select(m => (JsonElement?)m).FirstOrDefault(), null);
            }
            var lookup = await LookupAsync(client, key, ct).ConfigureAwait(false);
            if (lookup.Error != null) return (null, lookup.Error);
            if (lookup.Row is not { } row || Int(row, "id") is not int id || id <= 0) return (null, null);
            var one = await client.GetAsync<JsonElement>("movie/" + id.ToString(CultureInfo.InvariantCulture), null, ArrCallClass.Read, ct).ConfigureAwait(false);
            return one.Ok ? (one.Value, null) : one.Error!.Kind == ArrErrorKind.NotFound ? (null, null) : (null, one.Error);
        }

        // ---------------- series ----------------

        private async Task<RequestBackendResult> SeriesAsync(Run run)
        {
            var (job, instance, client, key, ct) = (run.Job, run.Instance, run.Client, run.Key, run.Ct);
            var input = job.Input;
            var existing = await FindSeriesAsync(client, key, ct).ConfigureAwait(false);
            if (existing.Error != null) return ReadFailure(instance, existing.Error);
            var series = existing.Series;
            var merged = series != null;
            JsonElement? lookupRow = null;
            if (series == null)
            {
                var lookup = await LookupAsync(client, key, ct).ConfigureAwait(false);
                if (lookup.Error != null) return ReadFailure(instance, lookup.Error);
                if (lookup.Row is not { } row || Int(row, "tvdbId") is not > 0) return BackendResults.Hold("title_not_found", $"{instance.Name} couldn't find this series by its id.");
                if (Int(row, "id") is int arrId && arrId > 0)
                {
                    var current = await client.GetAsync<JsonElement>("series/" + arrId.ToString(CultureInfo.InvariantCulture), null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    if (!current.Ok) return ReadFailure(instance, current.Error!);
                    series = current.Value;
                    merged = true;
                }
                else
                {
                    lookupRow = row;
                }
            }
            // Every season asked for must exist in the arr's season list (a next season not announced yet can't be monitored).
            var known = SeasonNumbers(series ?? lookupRow!.Value);
            var wantedSeasons = input.Scope == "episodes" ? input.Episodes.Select(e => e.Season).Distinct().ToArray() : input.Seasons;
            var missing = wantedSeasons.Where(s => !known.Contains(s)).ToArray();
            if (missing.Length > 0)
                return BackendResults.Hold("not_aired", $"{instance.Name} doesn't list season {string.Join(", ", missing)} of this series yet.");

            var wrote = false;
            if (series == null)
            {
                var (defaults, stop) = await DefaultsAsync(run).ConfigureAwait(false);
                if (defaults == null) return stop!;
                if (Gate(run, wrote) is { } refused) return refused;
                var body = (JsonObject)JsonNode.Parse(lookupRow!.Value.GetRawText())!;
                body.Remove("id");
                var monitorSeasons = input.Scope != "episodes";
                body["seasons"] = new JsonArray(known.OrderBy(s => s).Select(s => (JsonNode)new JsonObject
                {
                    ["seasonNumber"] = s,
                    ["monitored"] = monitorSeasons && input.Seasons.Contains(s),
                }).ToArray());
                body["qualityProfileId"] = defaults.ProfileId;
                body["rootFolderPath"] = defaults.RootFolder;
                body["seriesType"] = defaults.SeriesType;
                body["seasonFolder"] = true;
                body["monitored"] = true;
                body["monitorNewItems"] = input.Scope == "future" ? "all" : "none";
                body["tags"] = new JsonArray(defaults.Tags.Select(t => (JsonNode)t).ToArray());
                // "skip": Sonarr keeps the season flags above (new episodes inherit them) instead of applying a
                // monitoring preset after its first refresh, so nothing is monitored that wasn't asked for.
                body["addOptions"] = new JsonObject
                {
                    ["monitor"] = "skip",
                    ["searchForMissingEpisodes"] = monitorSeasons,
                    ["searchForCutoffUnmetEpisodes"] = false,
                };
                var (added, stopped) = await WriteAsync<JsonElement>(run, false, HttpMethod.Post, "series", body).ConfigureAwait(false);
                if (stopped != null) return stopped;
                wrote = true;
                if (added.Ok)
                {
                    series = added.Value;
                    if (monitorSeasons) return await ConfirmAsync(run, false).ConfigureAwait(false);
                }
                else if (AlreadyAdded(added.Error!))
                {
                    var again = await FindSeriesAsync(client, key, ct).ConfigureAwait(false);
                    if (again.Series == null) return BackendResults.Maybe(job.WantId, $"{instance.Name} said the series is already added, but it couldn't be read back.");
                    series = again.Series;
                    merged = true;
                }
                else
                {
                    return WriteFailure(job, instance, added.Error!);
                }
            }

            var seriesId = Int(series!.Value, "id") ?? 0;
            if (seriesId <= 0) return BackendResults.Maybe(job.WantId, $"{instance.Name} answered without the series id.");
            var monitoredNow = Bool(series.Value, "monitored") == true;
            // Field-scoped edits only: the series flag (and new-season monitoring for "keep getting new episodes")...
            var editor = new Dictionary<string, object>();
            if (!monitoredNow && input.Scope == "episodes") editor["monitored"] = true;
            if (input.Scope == "future" && !string.Equals(Str(series.Value, "monitorNewItems"), "all", StringComparison.OrdinalIgnoreCase))
            {
                editor["monitored"] = true;
                editor["monitorNewItems"] = "all";
            }
            if (editor.Count > 0)
            {
                if (Gate(run, wrote) is { } refused) return refused;
                var partial = wrote;
                wrote = true;
                editor["seriesIds"] = new[] { seriesId };
                var (edit, stopped) = await WriteAsync<NoContent>(run, partial, HttpMethod.Put, "series/editor", editor).ConfigureAwait(false);
                if (stopped != null) return stopped;
                if (!edit.Ok) return WriteFailure(job, instance, edit.Error!, partial);
                if (editor.ContainsKey("monitored")) monitoredNow = true;
            }
            // ...the requested seasons' flags (seasonpass lists only those seasons; the others keep theirs)...
            if (input.Scope != "episodes")
            {
                var flags = SeasonFlags(series.Value);
                var off = input.Seasons.Where(s => flags.GetValueOrDefault(s) != true).ToArray();
                if (off.Length > 0 || !monitoredNow)
                {
                    if (Gate(run, wrote) is { } refused) return refused;
                    var partial = wrote;
                    wrote = true;
                    var pass = new
                    {
                        series = new[] { new { id = seriesId, monitored = true, seasons = input.Seasons.Select(s => new { seasonNumber = s, monitored = true }).ToArray() } },
                    };
                    var (sent, stopped) = await WriteAsync<NoContent>(run, partial, HttpMethod.Post, "seasonpass", pass).ConfigureAwait(false);
                    if (stopped != null) return stopped;
                    if (!sent.Ok) return WriteFailure(job, instance, sent.Error!, partial);
                }
            }
            // ...and exactly the requested episodes (every episode of a requested season, or the single episodes).
            var episodes = await EpisodesAsync(client, seriesId, input, merged, ct).ConfigureAwait(false);
            if (episodes.Error != null) return wrote ? BackendResults.Maybe(job.WantId, $"{instance.Name}'s episode list couldn't be read after the change.") : ReadFailure(instance, episodes.Error);
            var targets = episodes.Rows.Where(e => InScope(input, Int(e, "seasonNumber") ?? -1, Int(e, "episodeNumber") ?? -1)).ToList();
            if (input.Scope == "episodes")
            {
                var absent = input.Episodes.Where(ask => !targets.Any(e => Int(e, "seasonNumber") == ask.Season && Int(e, "episodeNumber") == ask.Episode)).ToArray();
                if (absent.Length > 0)
                {
                    var which = string.Join(", ", absent.Select(a => $"S{a.Season:00}E{a.Episode:00}"));
                    // Right after this request's own add the episode list is still filling in: sent again shortly. A resumed
                    // attempt that still doesn't see them holds for a person (the earlier part stays upstream, so the
                    // certainty stays unknown); it never loops without end.
                    if (wrote) return BackendResults.Resume(job.WantId, $"{instance.Name} doesn't list {which} yet; the request is sent again shortly.");
                    return job.Uncertain
                        ? BackendResults.HoldAfterWrite(job.WantId, "not_aired", $"{instance.Name} has the series but still doesn't list {which}.")
                        : BackendResults.Hold("not_aired", $"{instance.Name} doesn't list {which} of this series yet.");
                }
            }
            var unmonitored = targets.Where(e => Bool(e, "monitored") != true).Select(e => Int(e, "id") ?? 0).Where(id => id > 0).ToArray();
            if (unmonitored.Length > 0)
            {
                // Checked again here: the episode list may have taken a while (a new series), and authority can change meanwhile.
                if (Gate(run, wrote) is { } refused) return refused;
                var partial = wrote;
                wrote = true;
                var (monitor, stopped) = await WriteAsync<NoContent>(run, partial, HttpMethod.Put, "episode/monitor", new { episodeIds = unmonitored, monitored = true }).ConfigureAwait(false);
                if (stopped != null) return stopped;
                if (!monitor.Ok) return WriteFailure(job, instance, monitor.Error!, partial);
            }
            // Search after the change (guarded like a write: it starts downloads): the requested episodes, or each
            // requested season. The request isn't done until every search was accepted.
            if (Gate(run, wrote) is { } last) return last;
            if (input.Scope == "episodes")
            {
                var ids = targets.Select(e => Int(e, "id") ?? 0).Where(id => id > 0).ToArray();
                var before = wrote;
                wrote = true;
                var (search, stopped) = await WriteAsync<NoContent>(run, before, HttpMethod.Post, "command", new { name = "EpisodeSearch", episodeIds = ids }).ConfigureAwait(false);
                if (stopped != null) return stopped;
                if (!search.Ok) return SearchFailure(run, before, search.Error!);
            }
            else
            {
                foreach (var season in input.Seasons)
                {
                    if (Gate(run, wrote) is { } refused) return refused;
                    var before = wrote;
                    wrote = true;
                    var (search, stopped) = await WriteAsync<NoContent>(run, before, HttpMethod.Post, "command", new { name = "SeasonSearch", seriesId, seasonNumber = season }).ConfigureAwait(false);
                    if (stopped != null) return stopped;
                    if (!search.Ok) return SearchFailure(run, before, search.Error!);
                }
            }
            return await ConfirmAsync(run, merged).ConfigureAwait(false);
        }

        // The library entry for a series key: by TVDB id (from the key or a lookup row), else none.
        private async Task<(JsonElement? Series, ArrError? Error)> FindSeriesAsync(ArrClient client, TitleKey key, CancellationToken ct)
        {
            var tvdb = TvdbOf(key);
            if (tvdb is not > 0)
            {
                var lookup = await LookupAsync(client, key, ct).ConfigureAwait(false);
                if (lookup.Error != null) return (null, lookup.Error);
                if (lookup.Row is not { } row) return (null, null);
                if (Int(row, "id") is int arrId && arrId > 0)
                {
                    var one = await client.GetAsync<JsonElement>("series/" + arrId.ToString(CultureInfo.InvariantCulture), null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    return one.Ok ? (one.Value, null) : one.Error!.Kind == ArrErrorKind.NotFound ? (null, null) : (null, one.Error);
                }
                tvdb = Int(row, "tvdbId");
                if (tvdb is not > 0) return (null, null);
            }
            var read = await client.GetAsync<List<JsonElement>>("series", Query("tvdbId", tvdb.Value), ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!read.Ok) return (null, read.Error);
            return (read.Value!.Where(s => Int(s, "tvdbId") == tvdb).Select(s => (JsonElement?)s).FirstOrDefault(), null);
        }

        // The series' episodes. A series just added gets its episode list a moment later: wait for the
        // requested episodes (bounded), so single episodes can be monitored in the same pass.
        private async Task<(List<JsonElement> Rows, ArrError? Error)> EpisodesAsync(ArrClient client, int seriesId, MutationInput input, bool existed, CancellationToken ct)
        {
            // One read a second, for at most EpisodeWait.
            for (var waited = 0; ; waited++)
            {
                var read = await client.GetAsync<List<JsonElement>>("episode", Query("seriesId", seriesId), ArrCallClass.Read, ct).ConfigureAwait(false);
                if (!read.Ok) return (new List<JsonElement>(), read.Error);
                var rows = read.Value!;
                var complete = input.Scope != "episodes"
                    ? existed || input.Seasons.All(s => rows.Any(e => Int(e, "seasonNumber") == s))
                    : input.Episodes.All(ask => rows.Any(e => Int(e, "seasonNumber") == ask.Season && Int(e, "episodeNumber") == ask.Episode));
                if (complete || waited >= EpisodeWait.TotalSeconds) return (rows, null);
                await _delay(TimeSpan.FromSeconds(1), ct).ConfigureAwait(false);
            }
        }

        private static bool InScope(MutationInput input, int season, int episode)
            => input.Scope == "episodes" ? input.Episodes.Any(e => e.Season == season && e.Episode == episode) : input.Seasons.Contains(season);

        // ---------------- read-back ----------------

        private async Task<RequestBackendResult> ConfirmAsync(Run run, bool merged)
        {
            var verify = await VerifyAsync(run.Client, run.Job.Input, run.Key, run.Ct).ConfigureAwait(false);
            if (verify.Matched != true)
                return BackendResults.Maybe(run.Job.WantId, $"{run.Instance.Name} took the change, but a fresh read doesn't show it yet: {verify.Message}");
            Refresh(run.Instance, verify.ArrId, run.Key.IsMovie);
            // A resumed request finds its own earlier add or edits in place: not someone else's title.
            if (run.Job.Uncertain) return BackendResults.Done(run.Job.WantId, "accepted", "looking", $"In {run.Instance.Name}; monitored and searching.");
            var message = merged ? $"Already in {run.Instance.Name}; now monitored and searching." : $"Added to {run.Instance.Name} and searching.";
            return BackendResults.Done(run.Job.WantId, merged ? "merged" : "accepted", "looking", message);
        }

        /// <summary>
        /// Fresh read of the exact result: the title is in the arr and monitored; for series the series is
        /// monitored, every requested season is flagged and all of its episodes listed so far are monitored,
        /// each requested episode exists and is monitored, and "keep getting new episodes" has new-season
        /// monitoring on. Null <c>Matched</c>: the read failed. <c>Present</c>: the title is in the arr at all.
        /// </summary>
        internal async Task<(bool? Matched, string Message, int? ArrId, bool Present)> VerifyAsync(ArrClient client, MutationInput input, TitleKey key, CancellationToken ct)
        {
            if (key.IsMovie)
            {
                var movie = await FindMovieAsync(client, key, ct).ConfigureAwait(false);
                if (movie.Error != null) return (null, movie.Error.Message, null, false);
                if (movie.Movie is not { } m) return (false, "The movie isn't in the library.", null, false);
                return Bool(m, "monitored") == true ? (true, string.Empty, Int(m, "id"), true) : (false, "The movie isn't monitored.", Int(m, "id"), true);
            }
            var found = await FindSeriesAsync(client, key, ct).ConfigureAwait(false);
            if (found.Error != null) return (null, found.Error.Message, null, false);
            if (found.Series is not { } s) return (false, "The series isn't in the library.", null, false);
            var id = Int(s, "id") ?? 0;
            if (Bool(s, "monitored") != true) return (false, "The series isn't monitored.", id, true);
            if (input.Scope == "future" && !string.Equals(Str(s, "monitorNewItems"), "all", StringComparison.OrdinalIgnoreCase))
                return (false, "New seasons aren't monitored.", id, true);
            if (input.Scope != "episodes")
            {
                var flags = SeasonFlags(s);
                var off = input.Seasons.Where(n => flags.GetValueOrDefault(n) != true).ToArray();
                if (off.Length > 0) return (false, $"Season {string.Join(", ", off)} isn't monitored.", id, true);
            }
            var episodes = await client.GetAsync<List<JsonElement>>("episode", Query("seriesId", id), ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!episodes.Ok) return (null, episodes.Error!.Message, id, true);
            var rows = episodes.Value!.Where(e => InScope(input, Int(e, "seasonNumber") ?? -1, Int(e, "episodeNumber") ?? -1)).ToList();
            if (input.Scope == "episodes")
            {
                var absent = input.Episodes.Where(ask => !rows.Any(e => Int(e, "seasonNumber") == ask.Season && Int(e, "episodeNumber") == ask.Episode)).ToArray();
                if (absent.Length > 0) return (false, "Some requested episodes aren't listed yet.", id, true);
            }
            var unmonitored = rows.Count(e => Bool(e, "monitored") != true);
            return unmonitored > 0 ? (false, $"{unmonitored} requested episode(s) aren't monitored.", id, true) : (true, string.Empty, id, true);
        }

        // Status: the title's library entry, its queue and (series) episodes are re-read soon, so the change reaches the feed.
        private void Refresh(ArrConnection instance, int? arrId, bool movie)
        {
            if (arrId is > 0) _ = _store.RefreshTitlesAsync(instance.Id, new[] { arrId.Value }, CancellationToken.None);
            _store.RequestRefresh(instance.Id, ArrSnapshotKind.Queue);
            if (!movie) _store.RequestRefresh(instance.Id, ArrSnapshotKind.Episodes);
        }

        // ---------------- lookups ----------------

        /// <summary>
        /// The lookup row for a key: <c>movie/lookup</c> or <c>series/lookup</c> with the provider id as the
        /// term, and only a row whose own id for that provider equals the key's (greater than zero) counts.
        /// </summary>
        internal static async Task<(JsonElement? Row, ArrError? Error)> LookupAsync(ArrClient client, TitleKey key, CancellationToken ct)
        {
            var term = key.Provider + ":" + key.Id;
            var read = await client.GetAsync<List<JsonElement>>(key.IsMovie ? "movie/lookup" : "series/lookup", new[] { new KeyValuePair<string, string?>("term", term) }, ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!read.Ok) return (null, read.Error);
            foreach (var row in read.Value!)
            {
                if (row.ValueKind != JsonValueKind.Object) continue;
                var matches = key.Provider switch
                {
                    "tmdb" => key.NumericId is > 0 && Int(row, "tmdbId") == key.NumericId,
                    "tvdb" => key.NumericId is > 0 && Int(row, "tvdbId") == key.NumericId,
                    "imdb" => string.Equals(Str(row, "imdbId"), key.Id, StringComparison.OrdinalIgnoreCase),
                    _ => false,
                };
                if (matches) return (row, null);
            }
            return (null, null);
        }

        private int? TmdbOf(TitleKey key)
            => key.Provider == "tmdb" ? key.NumericId : _aliases?.Of(key).FirstOrDefault(a => a.Provider == "tmdb")?.NumericId;

        private int? TvdbOf(TitleKey key)
            => key.Provider == "tvdb" ? key.NumericId : _aliases?.Of(key).FirstOrDefault(a => a.Provider == "tvdb")?.NumericId;

        // ---------------- outcomes ----------------

        // A failed read before any write: nothing was sent.
        private static RequestBackendResult ReadFailure(ArrConnection instance, ArrError error)
            => error.Kind == ArrErrorKind.Unauthorized
                ? BackendResults.Hold("service_down", $"{instance.Name} rejected the API key.")
                : BackendResults.Retry("backend_unavailable", $"{instance.Name} couldn't be read: {error.Message}");

        // A failed write: "maybe sent" unless the arr's answer proves nothing changed.
        private static RequestBackendResult WriteFailure(RequestJob job, ArrConnection instance, ArrError error, bool partial = false)
        {
            if (error.MaybeSent || error.Kind is ArrErrorKind.Server or ArrErrorKind.Conflict || partial && error.Kind is not ArrErrorKind.Validation)
                return BackendResults.Maybe(job.WantId, $"{instance.Name} didn't answer clearly ({error.Kind}); a fresh read decides what happened.");
            switch (error.Kind)
            {
                case ArrErrorKind.Unauthorized:
                    return BackendResults.Hold("service_down", $"{instance.Name} rejected the API key.");
                case ArrErrorKind.Validation:
                    var defaults = error.Validation.Any(v => v.Property is "QualityProfileId" or "RootFolderPath" or "Path" or "Tags");
                    return partial
                        ? BackendResults.Maybe(job.WantId, $"{instance.Name} refused part of the change: {error.Message}")
                        : BackendResults.Failed(defaults ? "invalid_defaults" : "instance_rejected", $"{instance.Name} refused the add: {error.Message}");
                case ArrErrorKind.NotFound:
                    return BackendResults.Hold("service_down", $"{instance.Name} answered 'not found'; check its URL base.");
                default:
                    return BackendResults.Retry("backend_unavailable", $"{instance.Name} couldn't be reached: {error.Message}");
            }
        }

        // "This movie/series has already been added": a merge, not a failure.
        private static bool AlreadyAdded(ArrError error)
            => error.Kind == ArrErrorKind.Validation && error.Validation.Any(v =>
                v.Property is "TmdbId" or "TvdbId" or "ImdbId" or "Path" && v.Message.Contains("already been added", StringComparison.OrdinalIgnoreCase));

        // ---------------- JSON ----------------

        private static IEnumerable<KeyValuePair<string, string?>> Query(string name, int value)
            => new[] { new KeyValuePair<string, string?>(name, value.ToString(CultureInfo.InvariantCulture)) };

        private static HashSet<int> SeasonNumbers(JsonElement series)
            => series.TryGetProperty("seasons", out var seasons) && seasons.ValueKind == JsonValueKind.Array
                ? seasons.EnumerateArray().Select(s => Int(s, "seasonNumber")).Where(n => n is >= 0).Select(n => n!.Value).ToHashSet()
                : new HashSet<int>();

        private static Dictionary<int, bool> SeasonFlags(JsonElement series)
        {
            var flags = new Dictionary<int, bool>();
            if (!series.TryGetProperty("seasons", out var seasons) || seasons.ValueKind != JsonValueKind.Array) return flags;
            foreach (var season in seasons.EnumerateArray())
            {
                if (Int(season, "seasonNumber") is int n) flags[n] = Bool(season, "monitored") == true;
            }
            return flags;
        }

        internal static int? Int(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;

        internal static bool? Bool(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null } : null;

        internal static string? Str(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private sealed class TagRow
        {
            public int Id { get; set; }

            public string? Label { get; set; }
        }
    }
}
