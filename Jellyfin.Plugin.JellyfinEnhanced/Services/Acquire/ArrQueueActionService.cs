using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>Queue actions the hub offers.</summary>
    public static class QueueAction
    {
        /// <summary>Remove from the queue, keeping the download client's data (optionally blocklist and search again).</summary>
        public const string Remove = "remove";
        /// <summary>Remove from the queue and delete the download client's data (Tier 3: a fresh confirmation token).</summary>
        public const string RemoveWithData = "remove_with_data";
        /// <summary>Ask the arr to check its finished downloads again (its own command).</summary>
        public const string RetryImport = "retry_import";
        /// <summary>Search again for what the download covers.</summary>
        public const string Search = "search";

        /// <summary>The audit action name of a queue action.</summary>
        public static string AuditName(string action) => "queue." + action;
    }

    /// <summary>A queue action to run (the controller validates the shape).</summary>
    public sealed class QueueActionInput
    {
        /// <summary>Instance id.</summary>
        public string InstanceId { get; init; } = string.Empty;

        /// <summary>The download (as listed on the Activity tab).</summary>
        public string DownloadId { get; init; } = string.Empty;

        /// <summary><see cref="QueueAction"/>.</summary>
        public string Action { get; init; } = string.Empty;

        /// <summary>Remove: also blocklist the release.</summary>
        public bool Blocklist { get; init; }

        /// <summary>Remove: search for another copy afterwards.</summary>
        public bool SearchAgain { get; init; }

        /// <summary>One key per click.</summary>
        public string IdempotencyKey { get; init; } = string.Empty;

        /// <summary>The Tier-3 token (remove with data).</summary>
        public string? ConfirmationToken { get; init; }
    }

    /// <summary>What "remove with data" will affect, with the token that allows it once.</summary>
    public sealed class QueueConfirmation
    {
        /// <summary>The one-time token (two minutes).</summary>
        public string Token { get; init; } = string.Empty;

        /// <summary>When it expires (UTC).</summary>
        public DateTimeOffset ExpiresAt { get; init; }

        /// <summary>The download.</summary>
        public QueueGroup Download { get; init; } = new();
    }

    /// <summary>
    /// The Activity tab's queue actions (Requests &amp; downloads, phase 2), run through the audited
    /// action runner: remove from the queue keeping the client's data (optionally blocklisting the
    /// release and searching again), search again, retry the import through the arr's own command,
    /// and — administrators only, with a fresh server-issued confirmation token — remove together
    /// with the download client's data. A download is addressed by its download id; every queue row
    /// of it (a season pack's episodes) is acted on together. Nothing here is automatic: every call
    /// is an administrator's click. The arrs offer no way to change a download's priority in the
    /// download client, so neither does this.
    /// </summary>
    public sealed class ArrQueueActionService
    {
        private readonly ArrStateStore _store;
        private readonly ArrClientFactory _clients;
        private readonly ArrActionRunner _runner;
        private readonly ArrAuditLog _audit;
        private readonly ArrChangeFeed? _feed;

        /// <summary>The service (DI; tests may leave out the change feed).</summary>
        public ArrQueueActionService(ArrStateStore store, ArrClientFactory clients, ArrActionRunner runner, ArrAuditLog audit, ArrChangeFeed? feed)
        {
            _store = store;
            _clients = clients;
            _runner = runner;
            _audit = audit;
            _feed = feed;
        }

        /// <summary>The download as the queue snapshot has it (read from memory; a cold queue is loaded first).</summary>
        public async Task<QueueGroup?> FindAsync(string instanceId, string downloadId, CancellationToken cancellationToken)
        {
            var instance = _store.Registry.Get(instanceId);
            if (instance == null || !instance.Usable) return null;
            var queue = await _store.GetQueueAsync(instance, cancellationToken).ConfigureAwait(false);
            var library = await _store.GetLibraryAsync(instance, cancellationToken).ConfigureAwait(false);
            return NeedsAttention.Group(instance, queue.Value, library.Value).FirstOrDefault(g => string.Equals(g.DownloadId, downloadId, StringComparison.Ordinal));
        }

        /// <summary>Issues the Tier-3 token for removing one download together with its data, with what it covers.</summary>
        public async Task<QueueConfirmation?> ConfirmAsync(StatusViewer viewer, string instanceId, string downloadId, CancellationToken cancellationToken)
        {
            var group = await FindAsync(instanceId, downloadId, cancellationToken).ConfigureAwait(false);
            if (group == null || !group.Actions.Contains(QueueAction.RemoveWithData)) return null;
            var (token, expires) = _runner.Tokens.Issue(viewer.UserId, QueueAction.AuditName(QueueAction.RemoveWithData), group.InstanceId, Target(group.DownloadId));
            return new QueueConfirmation { Token = token, ExpiresAt = expires, Download = group };
        }

        /// <summary>Runs a queue action once per idempotency key (audited; Tier 3 needs its token).</summary>
        public async Task<ArrActionOutcome> RunAsync(StatusViewer viewer, string? userName, QueueActionInput input, CancellationToken cancellationToken)
        {
            // A retry of a click that already ran (its answer was lost) gets that outcome back, before
            // the queue is looked at: after a removal the download is no longer there to find.
            var replay = await _runner.ReplayAsync(viewer.UserId, QueueAction.AuditName(input.Action), input.InstanceId, input.IdempotencyKey, cancellationToken).ConfigureAwait(false);
            if (replay != null) return replay;
            var group = await FindAsync(input.InstanceId, input.DownloadId, cancellationToken).ConfigureAwait(false);
            var instance = _store.Registry.Get(input.InstanceId);
            if (group == null || instance == null)
            {
                return Refuse(viewer, userName, input, "not_in_queue", "That download is no longer in the queue.");
            }
            if (!group.Actions.Contains(input.Action))
            {
                return Refuse(viewer, userName, input, "not_available", "That action isn't available for this download.");
            }

            var details = new Dictionary<string, string>
            {
                ["title"] = Describe(group),
                ["instance"] = instance.Name,
                ["downloadId"] = group.DownloadId,
                ["rows"] = group.Ids.Count.ToString(CultureInfo.InvariantCulture),
            };
            if (group.Key != null) details["key"] = group.Key;
            if (group.Release != null) details["release"] = group.Release;

            var request = input.Action switch
            {
                QueueAction.Remove or QueueAction.RemoveWithData => RemoveRequest(viewer, userName, instance, group, input, details),
                QueueAction.RetryImport => CommandRequest(viewer, userName, instance, group, input, details, QueueAction.RetryImport, new { name = "RefreshMonitoredDownloads" }),
                _ => SearchRequest(viewer, userName, instance, group, input, details),
            };
            if (request == null) return Refuse(viewer, userName, input, "nothing_to_search", "There is nothing to search for in this download.");
            var outcome = await _runner.RunAsync(request, cancellationToken).ConfigureAwait(false);
            if (outcome.Status is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
            {
                _store.RequestRefresh(instance.Id, ArrSnapshotKind.Queue);
                _store.RequestRefresh(instance.Id, ArrSnapshotKind.History);
                if (group.Key != null && TitleKey.Parse(group.Key) is { } key) _feed?.Bump(new[] { key.Title.ToString() }, instance.Id);
            }
            return outcome;
        }

        /// <summary>A refusal before any arr call, written to the audit log like the runner's refusals.</summary>
        private ArrActionOutcome Refuse(StatusViewer viewer, string? userName, QueueActionInput input, string reason, string message)
        {
            var id = Guid.NewGuid().ToString("N");
            var audited = _audit.Append(new ArrAuditEntry
            {
                Id = id,
                Time = DateTimeOffset.UtcNow,
                UserId = viewer.UserId.ToString("N"),
                UserName = userName,
                Action = QueueAction.AuditName(input.Action),
                Tier = input.Action == QueueAction.RemoveWithData ? (int)ArrActionTier.Destructive : input.Action == QueueAction.Remove ? (int)ArrActionTier.Change : (int)ArrActionTier.Safe,
                InstanceId = input.InstanceId,
                Target = Target(input.DownloadId),
                Outcome = ArrActionStatus.Rejected.ToString().ToLowerInvariant(),
                Error = reason,
                Message = message,
            });
            return new ArrActionOutcome { Status = ArrActionStatus.Rejected, Message = message, AuditId = audited ? id : string.Empty, Audited = audited };
        }

        private ArrActionRequest RemoveRequest(StatusViewer viewer, string? userName, ArrConnection instance, QueueGroup group, QueueActionInput input, Dictionary<string, string> details)
        {
            var withData = input.Action == QueueAction.RemoveWithData;
            details["blocklist"] = input.Blocklist ? "yes" : "no";
            details["searchAgain"] = input.SearchAgain ? "yes" : "no";
            details["deleteData"] = withData ? "yes" : "no";
            var query = new List<KeyValuePair<string, string?>>
            {
                new("removeFromClient", withData ? "true" : "false"),
                new("blocklist", input.Blocklist ? "true" : "false"),
                // With a blocklist the arr searches again by itself unless told to skip it.
                new("skipRedownload", input.Blocklist && input.SearchAgain ? "false" : "true"),
            };
            string? searchFailed = null;
            return new ArrActionRequest
            {
                Action = QueueAction.AuditName(input.Action),
                InstanceId = instance.Id,
                Target = Target(group.DownloadId),
                UserId = viewer.UserId,
                UserName = userName,
                IdempotencyKey = input.IdempotencyKey,
                Tier = withData ? ArrActionTier.Destructive : ArrActionTier.Change,
                ConfirmationToken = input.ConfirmationToken,
                Details = details,
                Timeout = TimeSpan.FromSeconds(45),
                Execute = async ct =>
                {
                    var client = _clients.For(instance.Id);
                    if (!client.Ok) return client.Error;
                    var removed = group.Ids.Count == 1
                        ? await client.Value!.SendAsync<NoContent>(HttpMethod.Delete, "queue/" + group.Ids[0].ToString(CultureInfo.InvariantCulture), null, query, ct).ConfigureAwait(false)
                        : await client.Value!.SendAsync<NoContent>(HttpMethod.Delete, "queue/bulk", new { ids = group.Ids }, query, ct).ConfigureAwait(false);
                    if (!removed.Ok) return removed.Error;
                    // Searching again without a blocklist: the arr's search command, after the removal.
                    if (input.SearchAgain && !input.Blocklist && SearchCommand(instance, group) is { } search)
                    {
                        var searched = await client.Value!.SendAsync<SearchCommandWire>(HttpMethod.Post, "command", search, null, ct).ConfigureAwait(false);
                        details["search"] = searched.Ok ? "sent" : "failed";
                        if (!searched.Ok)
                        {
                            searchFailed = Cap(searched.Error?.Message ?? "no answer");
                            details["searchError"] = searchFailed;
                        }
                    }
                    return null;
                },
                // The removal stands; a search that could not be started is said with it (the banner,
                // the audit line and Jellyfin's activity log all show the read-back).
                ReadBack = async ct =>
                {
                    var gone = await GoneAsync(instance, group, ct).ConfigureAwait(false);
                    return searchFailed == null
                        ? gone
                        : new ArrReadBack { Confirmed = gone.Confirmed, Summary = gone.Summary.TrimEnd('.') + "; the new search could not be started: " + searchFailed };
                },
            };
        }

        private ArrActionRequest? SearchRequest(StatusViewer viewer, string? userName, ArrConnection instance, QueueGroup group, QueueActionInput input, Dictionary<string, string> details)
        {
            var command = SearchCommand(instance, group);
            return command == null ? null : CommandRequest(viewer, userName, instance, group, input, details, QueueAction.Search, command);
        }

        private ArrActionRequest CommandRequest(StatusViewer viewer, string? userName, ArrConnection instance, QueueGroup group, QueueActionInput input, Dictionary<string, string> details, string action, object command)
        {
            int? id = null;
            return new ArrActionRequest
            {
                Action = QueueAction.AuditName(action),
                InstanceId = instance.Id,
                Target = Target(group.DownloadId),
                UserId = viewer.UserId,
                UserName = userName,
                IdempotencyKey = input.IdempotencyKey,
                Tier = ArrActionTier.Safe,
                Details = details,
                Timeout = TimeSpan.FromSeconds(30),
                Execute = async ct =>
                {
                    var client = _clients.For(instance.Id);
                    if (!client.Ok) return client.Error;
                    var sent = await client.Value!.SendAsync<SearchCommandWire>(HttpMethod.Post, "command", command, null, ct).ConfigureAwait(false);
                    if (!sent.Ok) return sent.Error;
                    id = sent.Value?.Id;
                    return null;
                },
                ReadBack = async ct =>
                {
                    if (id is not int commandId) return new ArrReadBack { Confirmed = null, Summary = "The instance accepted the command." };
                    var client = _clients.For(instance.Id);
                    if (!client.Ok) return new ArrReadBack { Confirmed = null, Summary = "Could not check the command." };
                    var until = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(10);
                    SearchCommandWire? last = null;
                    while (true)
                    {
                        var read = await client.Value!.GetAsync<SearchCommandWire>("command/" + commandId.ToString(CultureInfo.InvariantCulture), null, ArrCallClass.Read, ct).ConfigureAwait(false);
                        if (read.Ok) last = read.Value;
                        var state = last?.Status?.ToLowerInvariant();
                        if (state is "completed" or "failed" or "aborted" or "cancelled" || DateTimeOffset.UtcNow >= until) break;
                        await Task.Delay(TimeSpan.FromMilliseconds(500), ct).ConfigureAwait(false);
                    }
                    var message = string.IsNullOrWhiteSpace(last?.Message) ? null : last!.Message!.Trim();
                    return (last?.Status?.ToLowerInvariant()) switch
                    {
                        "completed" => new ArrReadBack { Confirmed = true, Summary = "Finished" + (message != null && !string.Equals(message, "Completed", StringComparison.OrdinalIgnoreCase) ? ": " + Cap(message) : ".") },
                        "failed" or "aborted" or "cancelled" => new ArrReadBack { Confirmed = true, Summary = "The instance ended it without finishing" + (message != null ? ": " + Cap(message) : ".") },
                        null => new ArrReadBack { Confirmed = null, Summary = "Could not check the command." },
                        _ => new ArrReadBack { Confirmed = true, Summary = "Started; it is still running." },
                    };
                },
            };
        }

        /// <summary>The arr's search command for what a download covers (the movie, or its episodes).</summary>
        internal static object? SearchCommand(ArrConnection instance, QueueGroup group)
        {
            if (instance.Kind == ArrKind.Radarr)
                return group.ArrId is int movie ? new { name = "MoviesSearch", movieIds = new[] { movie } } : null;
            if (group.EpisodeIds.Count > 0) return new { name = "EpisodeSearch", episodeIds = group.EpisodeIds.ToArray() };
            return group.ArrId is int series ? new { name = "SeriesSearch", seriesId = series } : null;
        }

        /// <summary>Read-back of a removal: none of the download's rows is in the arr's queue any more.</summary>
        private async Task<ArrReadBack> GoneAsync(ArrConnection instance, QueueGroup group, CancellationToken ct)
        {
            var client = _clients.For(instance.Id);
            if (!client.Ok) return new ArrReadBack { Confirmed = null, Summary = "Could not check the queue." };
            var rows = await client.Value!.GetAsync<List<QueueRowWire>>("queue/details", null, ArrCallClass.List, ct).ConfigureAwait(false);
            if (!rows.Ok) return new ArrReadBack { Confirmed = null, Summary = "Could not check the queue." };
            var left = rows.Value!.Count(r => group.Ids.Contains(r.Id) || (!group.DownloadId.StartsWith("row:", StringComparison.Ordinal) && string.Equals(r.DownloadId, group.DownloadId, StringComparison.Ordinal)));
            return left == 0
                ? new ArrReadBack { Confirmed = true, Summary = "Removed from the queue." }
                : new ArrReadBack { Confirmed = false, Summary = $"{left.ToString(CultureInfo.InvariantCulture)} queue row(s) still there." };
        }

        private static string Target(string downloadId) => "download:" + downloadId;

        private static string Describe(QueueGroup g)
            => string.Join(" ", new[] { g.Title, g.Year?.ToString(CultureInfo.InvariantCulture) is { } y ? "(" + y + ")" : null, g.Scope }.Where(x => !string.IsNullOrEmpty(x)));

        private static string Cap(string text) => text.Length > 200 ? text[..200] + "…" : text;

        /// <summary>The parts of a command resource the actions read.</summary>
        internal sealed class SearchCommandWire
        {
            /// <summary>Command id.</summary>
            public int Id { get; set; }

            /// <summary>Status.</summary>
            public string? Status { get; set; }

            /// <summary>Message.</summary>
            public string? Message { get; set; }
        }

        /// <summary>The parts of a queue row the removal read-back looks at.</summary>
        internal sealed class QueueRowWire
        {
            /// <summary>Row id.</summary>
            public int Id { get; set; }

            /// <summary>Download id.</summary>
            public string? DownloadId { get; set; }
        }
    }
}
