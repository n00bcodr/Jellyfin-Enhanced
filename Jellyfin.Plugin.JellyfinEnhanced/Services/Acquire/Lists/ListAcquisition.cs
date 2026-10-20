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
        private readonly ListGate _gate;
        private readonly RequestService _requests;
        private readonly RequestOperations _operations;
        private readonly ListLinks _links;
        private readonly Logger _logger;

        /// <summary>Creates the service (DI).</summary>
        /// <param name="store">List store.</param>
        /// <param name="access">List access (its gate: the caller's access and parental visibility of entries, read again before every ask and answer).</param>
        /// <param name="requests">The shared request service.</param>
        /// <param name="operations">Durable confirmation operations.</param>
        /// <param name="links">List request links.</param>
        /// <param name="logger">JE logger.</param>
        public ListAcquisition(ListStore store, ListAccessService access, RequestService requests, RequestOperations operations, ListLinks links, Logger logger)
        {
            _store = store;
            _gate = access.Gate;
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
            var (error, entries, doc, visibility) = await EntriesAsync(access, placeholderIds, all, MaxPreview, cancellationToken).ConfigureAwait(false);
            if (error != null)
            {
                return error;
            }

            var items = new List<(Placeholder Placeholder, ListRequestPreviewItemDto Item, bool Askable, int Cost)>();
            foreach (var (placeholder, input, skip) in entries!)
            {
                var item = new ListRequestPreviewItemDto { PlaceholderId = placeholder.Id, Title = placeholder.Title };
                if (skip != null || input == null)
                {
                    item.Outcome = "skip";
                    item.Reason = skip ?? "not_requestable";
                    items.Add((placeholder, item, false, 0));
                    continue;
                }

                var preview = await _requests.PreviewAsync(access.User.Id, new CreateRequest("list-preview:" + placeholder.Id, input), cancellationToken, Origin(access, placeholder, null)).ConfigureAwait(false);
                var refused = preview.Outcome.Outcome != "accepted" && preview.Outcome.Outcome != "split" && preview.Outcome.HttpStatus >= 300;
                var askable = false;
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
                    askable = true;
                }

                items.Add((placeholder, item, askable, preview.Cost));
            }

            // The previews took a while: the answer holds only what the caller may see when it is answered (the gate
            // reads their access and limits again); a caller who can no longer see the list learns nothing of its entries.
            var dto = await _gate.ProjectAsync(access, doc?.Items ?? new List<Placeholder>(), visibility, grant =>
            {
                var shown = items.Where(i => grant.Visibility.IsVisible(i.Placeholder)).ToList();
                var answer = new ListRequestPreviewDto { MaxBatch = RequestOperations.MaxBatch, Askable = shown.Count(i => i.Askable), Cost = shown.Where(i => i.Askable).Sum(i => i.Cost) };
                answer.Items.AddRange(shown.Select(i => i.Item));
                return answer;
            }, cancellationToken).ConfigureAwait(false);
            return dto == null ? ListOutcome.Error(404, "not_found", "List not found.") : ListOutcome.Ok(dto);
        }

        /// <summary>
        /// Asks for at most <see cref="RequestOperations.MaxBatch"/> entries as one confirmation. What is confirmed is the
        /// list and its entries in order; each entry's normalised request input, its backend target and the request id it
        /// asks with are stored with the confirmation before anything is asked, and a retry (or a restart) resumes from
        /// them, so it asks for what was confirmed even after the entries' metadata changed, and nothing twice. Before
        /// each ask the gate reads the caller's access and limits again: an entry they can no longer see is not asked for.
        /// </summary>
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

            var fingerprint = MutationInput.Hash("list-confirmation|" + access.ListIdN + "|" + string.Join(";", placeholderIds))[..64];
            var operation = _operations.Find(access.User.Id, RequestOperations.RequestBatch, clientId);
            var replayed = operation != null;
            PlaceholderVisibility? visibility = null;
            if (operation != null)
            {
                if (operation.Fingerprint != fingerprint || operation.Subject != "list:" + access.ListIdN || ReadChildren(operation.Payload) == null)
                {
                    return ListOutcome.Error(409, "idempotency_conflict", "This confirmation was already used for other entries.");
                }
            }
            else
            {
                var (error, entries, _, checkedVisibility) = await EntriesAsync(access, placeholderIds, false, RequestOperations.MaxBatch, cancellationToken).ConfigureAwait(false);
                if (error != null)
                {
                    return error;
                }

                visibility = checkedVisibility;
                // Each entry's normalised input, the backend target it is confirmed against and the request id it asks
                // with, stored with the confirmation in the same write that records it (before anything is asked). Where
                // the ask is sent is still decided by the policy at sending time.
                var start = _operations.Begin(access.User.Id, RequestOperations.RequestBatch, clientId, fingerprint, "list:" + access.ListIdN, entries!.Count, Now(), id => JsonSerializer.Serialize(new Children
                {
                    Items = entries.Select(e => e.Skip != null || e.Input == null
                        ? new Child { PlaceholderId = e.Placeholder.Id, Skip = e.Skip ?? "not_requestable" }
                        : ChildOf(id, access.User.Id, e.Placeholder.Id, e.Input)).ToList(),
                }));
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

                operation = start.Operation;
                replayed = start.Replayed;
            }

            var children = ReadChildren(operation.Payload) ?? new List<Child>();
            var result = new ListRequestSubmitDto { OperationId = operation.Id, Replayed = replayed };
            foreach (var child in children)
            {
                if (child.Skip != null || child.Input == null || child.RequestId == null)
                {
                    result.Results.Add(new ListRequestResultDto { PlaceholderId = child.PlaceholderId, Result = RequestOutcome.Refused(child.Skip ?? "not_requestable", 422) });
                    continue;
                }

                // The gate, right before each ask: the caller can still see the list, and this entry (still there, still the
                // same title) under their limits as they are now. Each ask waits for the one before it.
                var doc = _store.Load(access.ListIdN);
                var grant = await _gate.GrantAsync(access, doc?.Items ?? new List<Placeholder>(), visibility, cancellationToken).ConfigureAwait(false);
                var placeholder = doc?.Items.FirstOrDefault(p => p.Id == child.PlaceholderId);
                if (grant == null || placeholder == null || !grant.Visibility.IsVisible(placeholder) || ListRules.TitleKeyOf(placeholder)?.ToString() != child.Input.Key)
                {
                    result.Results.Add(new ListRequestResultDto { PlaceholderId = child.PlaceholderId, Result = RequestOutcome.Refused("not_found", 404) });
                    continue;
                }

                visibility = grant.Visibility;
                RequestOutcome outcome;
                try
                {
                    outcome = await _requests.CreateAsync(grant.Access.User.Id, new CreateRequest(child.RequestId, child.Input), cancellationToken, Origin(grant.Access, placeholder, operation.Id, doc?.Rev ?? 0)).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.Warning($"[Lists] Asking for entry {placeholder.Id} from list {access.ListIdN} failed: {UpstreamDiagnostics.Code(ex)}");
                    outcome = RequestOutcome.Refused("server_error", 503, "failed");
                }

                foreach (var wantId in new[] { outcome.RequestId, outcome.HeldRequestId }.OfType<string>())
                {
                    try
                    {
                        _links.Add(new ListLink(access.ListIdN, placeholder.Id, access.User.Id, wantId, operation.Id, child.Input.Key, child.Input.Canonical, child.Input.Variant), Now());
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Lists] Recording the request link of entry {placeholder.Id} failed: {ex.Message}");
                    }
                }

                result.Results.Add(new ListRequestResultDto { PlaceholderId = child.PlaceholderId, Result = outcome });
            }

            _operations.Finish(operation.Id, "completed", Now());
            return ListOutcome.Ok(result);
        }

        // One askable entry of a new confirmation: its normalised input, the target it is confirmed against and the request
        // id it asks with (from the operation, the person, the input and that target).
        private Child ChildOf(string operationId, Guid user, string placeholderId, MutationInput input)
        {
            var target = RequestLedger.TargetKey(_requests.Identity(user, input.Scope == "movie"));
            return new Child
            {
                PlaceholderId = placeholderId,
                Input = input,
                Target = target,
                RequestId = RequestOperations.ChildRequestId(operationId, user, input, target) ?? ("op:" + operationId + ":" + placeholderId),
            };
        }

        // The entries a preview/submit looks at, in list order, each with its request input or why it can't be asked for;
        // with the document and what the caller sees of it (checked against their limits now).
        private async Task<(ListOutcome? Error, List<(Placeholder Placeholder, MutationInput? Input, string? Skip)>? Entries, ListDoc? Doc, PlaceholderVisibility? Visibility)> EntriesAsync(
            ListAccess access, IReadOnlyList<string>? placeholderIds, bool all, int max, CancellationToken cancellationToken)
        {
            var doc = _store.Load(access.ListIdN);
            var items = doc?.Items ?? new List<Placeholder>();
            var visibility = await _gate.VisibilityAsync(items, access.User, cancellationToken).ConfigureAwait(false);
            var visible = items.Where(visibility.IsVisible).ToList();
            List<Placeholder> chosen;
            if (all && (placeholderIds == null || placeholderIds.Count == 0))
            {
                chosen = InListOrder(doc, visible).Where(p => p.Kind != PlaceholderKinds.Custom).Take(max).ToList();
            }
            else
            {
                if (placeholderIds == null || placeholderIds.Count == 0 || placeholderIds.Count > max || placeholderIds.Distinct(StringComparer.Ordinal).Count() != placeholderIds.Count)
                {
                    return (ListOutcome.Error(400, "invalid_body", $"Send 1-{max} different entries."), null, null, null);
                }

                var byId = visible.ToDictionary(p => p.Id, StringComparer.Ordinal);
                chosen = new List<Placeholder>(placeholderIds.Count);
                foreach (var id in placeholderIds)
                {
                    // An entry the caller can't see (or that is gone) answers like one that doesn't exist.
                    if (!byId.TryGetValue(id, out var placeholder))
                    {
                        return (ListOutcome.Error(404, "not_found", "Entry not found."), null, null, null);
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

            return (null, result, doc, visibility);
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

        // The entries a confirmation stored, or null when it has none (an older confirmation, or one that can't be read).
        private static List<Child>? ReadChildren(string? payload)
        {
            if (string.IsNullOrEmpty(payload))
            {
                return null;
            }

            try
            {
                var children = JsonSerializer.Deserialize<Children>(payload)?.Items;
                return children == null || children.Count == 0 || children.Any(c => c == null || string.IsNullOrEmpty(c.PlaceholderId) || (c.Skip == null && (c.Input?.Normalize() == null || c.RequestId == null)))
                    ? null
                    : children;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static RequestOrigin Origin(ListAccess access, Placeholder placeholder, string? operationId, int? rev = null) =>
            RequestOrigin.List(access.ListIdN, new RequestProvenance(EntryId: placeholder.Id, ListRevision: rev, OperationId: operationId));

        // A request confirmation's payload: every confirmed entry in order, each with what it asks with or why it isn't asked.
        private sealed class Children
        {
            [JsonPropertyName("v")]
            public int Version { get; set; } = 2;

            [JsonPropertyName("entries")]
            public List<Child> Items { get; set; } = new();
        }

        // One confirmed entry.
        private sealed class Child
        {
            [JsonPropertyName("ph")]
            public string PlaceholderId { get; set; } = string.Empty;

            [JsonPropertyName("skip")]
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? Skip { get; set; }

            [JsonPropertyName("input")]
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public MutationInput? Input { get; set; }

            [JsonPropertyName("target")]
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? Target { get; set; }

            [JsonPropertyName("request")]
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? RequestId { get; set; }
        }
    }
}
