using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Asking for list entries (Request one, Request all missing). Every ask goes through the shared request service
    /// (ledger, household rules and allowances, approvals, outbox, the selected backend) as the caller's own request with
    /// a server-built <c>source=list:{id}</c> origin; the list never asks on its own and never becomes a second ledger.
    /// <list type="bullet">
    /// <item>Preview writes nothing (the ledger's no-write preview) and is rechecked on submit.</item>
    /// <item>At most <see cref="RequestOperations.MaxBatch"/> entries per confirmation, server-enforced, with ordered
    /// per-entry outcomes. Each confirmation is a durable operation; each entry's request id derives from the operation
    /// and the person, title, scope, edition and target, so a retry or a restart asks with the same ids (nothing twice)
    /// and every new confirmation gets new ids (the ledger merges with what is already asked for).</item>
    /// <item>Seeing a list is not permission to ask: the request policy decides, and each person pays for their own.</item>
    /// <item>The links (which person's request an entry asked for) are recorded for the list; removing an entry or a
    /// list never cancels a request.</item>
    /// </list>
    /// </summary>
    public sealed class ListAcquisition
    {
        /// <summary>Most entries one preview looks at.</summary>
        public const int MaxPreview = 300;

        private readonly ListStore _store;
        private readonly ListAccessService _access;
        private readonly RequestService _requests;
        private readonly RequestOperations _operations;
        private readonly ListLinks _links;
        private readonly Logger _logger;

        /// <summary>Creates the service (DI).</summary>
        /// <param name="store">List store.</param>
        /// <param name="access">List access (parental visibility of entries).</param>
        /// <param name="requests">The shared request service.</param>
        /// <param name="operations">Durable confirmation operations.</param>
        /// <param name="links">List request links.</param>
        /// <param name="logger">JE logger.</param>
        public ListAcquisition(ListStore store, ListAccessService access, RequestService requests, RequestOperations operations, ListLinks links, Logger logger)
        {
            _store = store;
            _access = access;
            _requests = requests;
            _operations = operations;
            _links = links;
            _logger = logger;
        }

        /// <summary>Clock (tests move it).</summary>
        internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

        /// <summary>What asking for entries would do (nothing is written).</summary>
        /// <param name="access">Authorised access (CanView).</param>
        /// <param name="placeholderIds">Entries, or null/empty with <paramref name="all"/>.</param>
        /// <param name="all">Every entry the caller can see.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListRequestPreviewDto"/>).</returns>
        public async Task<ListOutcome> PreviewAsync(ListAccess access, IReadOnlyList<string>? placeholderIds, bool all, CancellationToken cancellationToken)
        {
            var (error, entries) = await EntriesAsync(access, placeholderIds, all, MaxPreview, cancellationToken).ConfigureAwait(false);
            if (error != null)
            {
                return error;
            }

            var dto = new ListRequestPreviewDto { MaxBatch = RequestOperations.MaxBatch };
            foreach (var (placeholder, input, skip) in entries!)
            {
                var item = new ListRequestPreviewItemDto { PlaceholderId = placeholder.Id, Title = placeholder.Title };
                if (skip != null || input == null)
                {
                    item.Outcome = "skip";
                    item.Reason = skip ?? "not_requestable";
                    dto.Items.Add(item);
                    continue;
                }

                var preview = await _requests.PreviewAsync(access.User.Id, new CreateRequest("list-preview:" + placeholder.Id, input), cancellationToken, Origin(access, placeholder, null)).ConfigureAwait(false);
                var refused = preview.Outcome.Outcome != "accepted" && preview.Outcome.Outcome != "split" && preview.Outcome.HttpStatus >= 300;
                if (refused)
                {
                    item.Outcome = "skip";
                    item.Reason = preview.Outcome.Reason;
                }
                else if (!preview.New && !preview.Follower && preview.Outcome.RequestId != null)
                {
                    item.Outcome = "already";
                    item.Reason = preview.Reason ?? preview.Outcome.Reason;
                }
                else
                {
                    item.Outcome = preview.Follower ? "follow" : preview.Status == "pending" ? "approval" : "request";
                    item.Reason = preview.Reason ?? preview.Outcome.Reason;
                    item.Cost = preview.Cost;
                    dto.Askable++;
                    dto.Cost += preview.Cost;
                }

                dto.Items.Add(item);
            }

            // The previews took a while: a caller who can no longer see the list learns nothing of its entries.
            if (_access.Current(access) == null)
            {
                return ListOutcome.Error(404, "not_found", "List not found.");
            }

            return ListOutcome.Ok(dto);
        }

        /// <summary>Asks for at most <see cref="RequestOperations.MaxBatch"/> entries as one confirmation.</summary>
        /// <param name="access">Authorised access (CanView).</param>
        /// <param name="clientId">The caller's confirmation id.</param>
        /// <param name="placeholderIds">Entries, in order.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListRequestSubmitDto"/>, without the view).</returns>
        public async Task<ListOutcome> SubmitAsync(ListAccess access, string clientId, IReadOnlyList<string> placeholderIds, CancellationToken cancellationToken)
        {
            if (placeholderIds.Count == 0 || placeholderIds.Count > RequestOperations.MaxBatch)
            {
                return ListOutcome.Error(400, "batch_too_large", $"Ask for 1-{RequestOperations.MaxBatch} entries at a time.");
            }

            var (error, entries) = await EntriesAsync(access, placeholderIds, false, RequestOperations.MaxBatch, cancellationToken).ConfigureAwait(false);
            if (error != null)
            {
                return error;
            }

            // The server's own normalized items are the confirmation's fingerprint (a retry asking for something else is refused).
            var fingerprint = MutationInput.Hash(access.ListIdN + "|" + string.Join(";", entries!.Select(e => e.Placeholder.Id + "=" + (e.Input?.Canonical ?? "-"))))[..64];
            // Each entry's backend target is recorded with the confirmation, before anything is asked: a retry after the
            // backend, instance or connection changed derives the same request ids from it (the ledger answers them) and
            // never asks twice. Where the ask is sent is still decided by the policy at sending time.
            var targets = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (placeholder, input, skip) in entries!)
            {
                if (skip == null && input != null)
                {
                    targets[placeholder.Id] = RequestLedger.TargetKey(_requests.Identity(access.User.Id, input.Scope == "movie"));
                }
            }

            var start = _operations.Begin(access.User.Id, RequestOperations.RequestBatch, clientId, fingerprint, "list:" + access.ListIdN, entries!.Count, Now(), JsonSerializer.Serialize(new ChildTargets { Targets = targets }));
            if (start.Operation == null)
            {
                return start.Refusal switch
                {
                    "idempotency_conflict" => ListOutcome.Error(409, "idempotency_conflict", "This confirmation was already used for other entries."),
                    "batch_too_large" => ListOutcome.Error(400, "batch_too_large", $"Ask for 1-{RequestOperations.MaxBatch} entries at a time."),
                    "database_unavailable" => ListOutcome.Error(503, "database_unavailable", "Couldn't ask right now. Try again later."),
                    _ => ListOutcome.Error(400, "invalid_input", "Invalid confirmation."),
                };
            }

            var operation = start.Operation;
            // The targets recorded when the confirmation was first made (null for one recorded without them).
            var recorded = RecordedTargets(operation.Payload);
            var rev = _store.Load(access.ListIdN)?.Rev ?? 0;
            var result = new ListRequestSubmitDto { OperationId = operation.Id, Replayed = start.Replayed };
            foreach (var (placeholder, input, skip) in entries!)
            {
                if (skip != null || input == null)
                {
                    result.Results.Add(new ListRequestResultDto { PlaceholderId = placeholder.Id, Result = RequestOutcome.Refused(skip ?? "not_requestable", 422) });
                    continue;
                }

                // Each ask waits for the one before it: a caller who can no longer see the list asks for nothing more.
                if (_access.Current(access) == null)
                {
                    result.Results.Add(new ListRequestResultDto { PlaceholderId = placeholder.Id, Result = RequestOutcome.Refused("not_found", 404) });
                    continue;
                }

                var target = recorded != null && recorded.TryGetValue(placeholder.Id, out var original)
                    ? original
                    : RequestLedger.TargetKey(_requests.Identity(access.User.Id, input.Scope == "movie"));
                var child = RequestOperations.ChildRequestId(operation.Id, access.User.Id, input, target) ?? ("op:" + operation.Id + ":" + placeholder.Id);
                RequestOutcome outcome;
                try
                {
                    outcome = await _requests.CreateAsync(access.User.Id, new CreateRequest(child, input), cancellationToken, Origin(access, placeholder, operation.Id, rev)).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.Warning($"[Lists] Asking for \"{placeholder.Title}\" from list {access.ListIdN} failed: {ex.Message}");
                    outcome = RequestOutcome.Refused("server_error", 503, "failed");
                }

                foreach (var wantId in new[] { outcome.RequestId, outcome.HeldRequestId }.OfType<string>())
                {
                    try
                    {
                        _links.Add(new ListLink(access.ListIdN, placeholder.Id, access.User.Id, wantId, operation.Id, input.Key, input.Canonical, input.Variant), Now());
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Lists] Recording the request link of \"{placeholder.Title}\" failed: {ex.Message}");
                    }
                }

                result.Results.Add(new ListRequestResultDto { PlaceholderId = placeholder.Id, Result = outcome });
            }

            _operations.Finish(operation.Id, "completed", Now());
            return ListOutcome.Ok(result);
        }

        // The entries a preview/submit looks at, in list order, each with its request input or why it can't be asked for.
        private async Task<(ListOutcome? Error, List<(Placeholder Placeholder, MutationInput? Input, string? Skip)>? Entries)> EntriesAsync(
            ListAccess access, IReadOnlyList<string>? placeholderIds, bool all, int max, CancellationToken cancellationToken)
        {
            var doc = _store.Load(access.ListIdN);
            var items = doc?.Items ?? new List<Placeholder>();
            var hidden = await _access.GetHiddenPlaceholderIdsAsync(items, access.User, cancellationToken).ConfigureAwait(false);
            var visible = items.Where(p => !hidden.Contains(p.Id)).ToList();
            List<Placeholder> chosen;
            if (all && (placeholderIds == null || placeholderIds.Count == 0))
            {
                chosen = InListOrder(doc, visible).Where(p => p.Kind != PlaceholderKinds.Custom).Take(max).ToList();
            }
            else
            {
                if (placeholderIds == null || placeholderIds.Count == 0 || placeholderIds.Count > max || placeholderIds.Distinct(StringComparer.Ordinal).Count() != placeholderIds.Count)
                {
                    return (ListOutcome.Error(400, "invalid_body", $"Send 1-{max} different entries."), null);
                }

                var byId = visible.ToDictionary(p => p.Id, StringComparer.Ordinal);
                chosen = new List<Placeholder>(placeholderIds.Count);
                foreach (var id in placeholderIds)
                {
                    // An entry the caller can't see (or that is gone) answers like one that doesn't exist.
                    if (!byId.TryGetValue(id, out var placeholder))
                    {
                        return (ListOutcome.Error(404, "not_found", "Entry not found."), null);
                    }

                    chosen.Add(placeholder);
                }
            }

            var today = Now().UtcDateTime;
            var result = new List<(Placeholder, MutationInput?, string?)>(chosen.Count);
            foreach (var placeholder in chosen)
            {
                if (placeholder.Kind == PlaceholderKinds.Custom)
                {
                    result.Add((placeholder, null, "custom"));
                    continue;
                }

                if (!ListRules.IsReleased(placeholder, today))
                {
                    // Future and TBA entries belong in a list; being there doesn't make them requestable.
                    result.Add((placeholder, null, "not_released"));
                    continue;
                }

                var input = ListRules.RequestInput(placeholder);
                result.Add((placeholder, input, input == null ? "scope_unknown" : null));
            }

            return (null, result);
        }

        private static IEnumerable<Placeholder> InListOrder(ListDoc? doc, List<Placeholder> visible)
        {
            if (doc == null || doc.ListKind == ListKinds.Collection)
            {
                return ListOrder.SortForCollection(visible);
            }

            var byId = visible.ToDictionary(p => p.Id, StringComparer.Ordinal);
            var ordered = doc.Order.Select(ListOrder.PlaceholderIdOf).OfType<string>().Where(byId.ContainsKey).Select(id => byId[id]).ToList();
            ordered.AddRange(visible.Where(p => !ordered.Contains(p)));
            return ordered;
        }

        // The per-entry targets of a confirmation's payload, or null when it has none (or it can't be read).
        private static Dictionary<string, string>? RecordedTargets(string? payload)
        {
            if (string.IsNullOrEmpty(payload))
            {
                return null;
            }

            try
            {
                return JsonSerializer.Deserialize<ChildTargets>(payload)?.Targets is { } targets ? new Dictionary<string, string>(targets, StringComparer.Ordinal) : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static RequestOrigin Origin(ListAccess access, Placeholder placeholder, string? operationId, int? rev = null) =>
            RequestOrigin.List(access.ListIdN, new RequestProvenance(EntryId: placeholder.Id, ListRevision: rev, OperationId: operationId));

        // A request confirmation's payload: the backend target each askable entry was confirmed against.
        private sealed class ChildTargets
        {
            [JsonPropertyName("targets")]
            public Dictionary<string, string> Targets { get; set; } = new(StringComparer.Ordinal);
        }
    }
}
