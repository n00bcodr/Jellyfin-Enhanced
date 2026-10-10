using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources
{
    /// <summary>A link to establish (validated, provider decided).</summary>
    /// <param name="Kind">Source kind.</param>
    /// <param name="Url">Canonical URL.</param>
    /// <param name="Provider">Upstream to pin.</param>
    /// <param name="Title">List title.</param>
    /// <param name="SyncEnabled">Keep in sync.</param>
    /// <param name="RemoveDropped">Remove entries that leave the list.</param>
    public sealed record SourceLinkSpec(string Kind, string Url, string Provider, string? Title, bool SyncEnabled, bool RemoveDropped);

    /// <summary>
    /// Linked lists (design §8, F1–F6): fetching list URLs for the import review, linking/unlinking a list to a source,
    /// import provenance, and the sync itself (scheduled or "Sync now"). A sync runs with the rights of the user who
    /// linked the source and pauses itself when that user can no longer edit the list; it adds new source entries at
    /// the end (real items when the library has them, else placeholders), never re-adds what an editor removed, and with
    /// removeDropped removes only what the import/sync itself added — never on a partial or failed fetch.
    /// </summary>
    public sealed class ListSourceService
    {
        /// <summary>How long "Sync now" waits before answering 202 (the sync keeps running).</summary>
        public static readonly TimeSpan SyncNowWait = TimeSpan.FromSeconds(25);

        /// <summary>Deadline of one resolve chunk of a sync (background: nobody waits on it).</summary>
        public static readonly TimeSpan SyncChunkDeadline = TimeSpan.FromSeconds(90);

        /// <summary>Pause code: the user who linked the source no longer exists.</summary>
        public const string LinkerMissing = "linker_missing";

        /// <summary>Pause code: the user who linked the source can no longer edit the list.</summary>
        public const string LinkerCannotEdit = "linker_cannot_edit";

        /// <summary>Pause code: the linked URL is no longer supported.</summary>
        public const string UrlUnsupported = "url_unsupported";

        /// <summary>Pause code: entries the sync would remove are hidden from the user who linked the source (F3).</summary>
        public const string LinkerCannotSee = "linker_cannot_see";

        private static readonly JsonSerializerOptions ReplayJson = new() { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

        private readonly ListPlaceholderStore _store;
        private readonly ListAccessService _access;
        private readonly ListPlaceholderService _lists;
        private readonly IListPlaceholderHost _host;
        private readonly IListEntryRemover _remover;
        private readonly IListSourceFetcher _fetcher;
        private readonly ListImportResolver _resolver;
        private readonly IUserManager _users;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, Task<SourceSyncResultDto>> _running = new(StringComparer.Ordinal);
        private static int _lastGeneration;

        /// <summary>Creates the service.</summary>
        /// <param name="store">Store.</param>
        /// <param name="access">Access.</param>
        /// <param name="lists">Placeholder service (apply).</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="remover">Real-entry remover.</param>
        /// <param name="fetcher">Source fetcher.</param>
        /// <param name="resolver">Import resolver.</param>
        /// <param name="users">User manager.</param>
        /// <param name="logger">JE logger.</param>
        public ListSourceService(
            ListPlaceholderStore store,
            ListAccessService access,
            ListPlaceholderService lists,
            IListPlaceholderHost host,
            IListEntryRemover remover,
            IListSourceFetcher fetcher,
            ListImportResolver resolver,
            IUserManager users,
            Logger logger)
        {
            _store = store;
            _access = access;
            _lists = lists;
            _host = host;
            _remover = remover;
            _fetcher = fetcher;
            _resolver = resolver;
            _users = users;
            _logger = logger;
        }

        /// <summary>Provider capabilities (GET /source/providers).</summary>
        /// <returns>Capabilities.</returns>
        public SourceProvidersDto Providers() => _fetcher.Providers();

        // ── Fetch (POST /source/fetch) ──────────────────────────────────────

        /// <summary>Fetches a list URL for the import review: entries with ids, filtered for restricted callers (C5).</summary>
        /// <param name="caller">Caller.</param>
        /// <param name="url">List URL.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns><see cref="SourceFetchResponse"/>, or an error (504 parental_pending when checks didn't finish).</returns>
        public async Task<ListOutcome> FetchAsync(User caller, string? url, CancellationToken cancellationToken)
        {
            if (!ListSourceUrl.TryParse(url, out var source, out var parseError))
            {
                return ParseFailure(parseError);
            }

            var result = await _fetcher.FetchAsync(source!, new SourceFetchOptions { AllowMdblistApi = ListAccessService.IsAdmin(caller) }, cancellationToken).ConfigureAwait(false);
            if (!result.Ok)
            {
                return FetchFailure(result);
            }

            var response = new SourceFetchResponse
            {
                Kind = result.Kind,
                Provider = result.Provider,
                Url = result.CanonicalUrl,
                Title = result.Title,
                Unofficial = result.Unofficial,
                Total = result.Total,
                Truncated = result.Truncated,
            };

            var items = result.Items.Where(i => i.Key != null).ToList();
            response.Dropped = result.Items.Count - items.Count;
            if (_access.IsRestricted(caller))
            {
                var (allowed, pending) = await FilterRestrictedAsync(items, caller, cancellationToken).ConfigureAwait(false);
                if (pending)
                {
                    return new ListOutcome { StatusCode = 504, RetryAfterSeconds = 2, Value = new ListErrorDto { Code = "parental_pending", Message = "Checking titles against your parental controls; try again in a moment." } };
                }

                items = allowed;
            }

            response.Entries = items.Select((item, i) => ToEntry(item, i)).ToList();
            return ListOutcome.Ok(response);
        }

        /// <summary>A fetched entry as an import entry (feed to /resolve; carries its source key).</summary>
        /// <param name="item">Source entry.</param>
        /// <param name="index">Position.</param>
        /// <returns>The entry.</returns>
        public static ImportEntryDto ToEntry(SourceItem item, int index)
        {
            var ids = new ImportIdsDto
            {
                Tmdb = item.TmdbId,
                TmdbType = item.TmdbId.HasValue ? item.MediaType : null,
                Imdb = item.ImdbId,
                Tvdb = item.MediaType == "tv" ? item.TvdbId : null,
            };
            return new ImportEntryDto
            {
                Index = index,
                Title = item.Title,
                Year = item.Year,
                TypeHint = item.MediaType,
                Season = item.Season,
                Episodes = item.Season.HasValue && item.Episode.HasValue ? new List<ImportEpisodeDto> { new() { S = item.Season.Value, E = item.Episode.Value } } : null,
                Ids = ids,
                Note = item.Note,
                SourceKey = item.Key,
            };
        }

        // C5 for fetched lists: restricted callers keep only TMDB titles their parental controls allow.
        private async Task<(List<SourceItem> Allowed, bool Pending)> FilterRestrictedAsync(List<SourceItem> items, User caller, CancellationToken cancellationToken)
        {
            var allowed = new List<SourceItem>();
            var pending = false;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ListImportResolver.ParentalBudget);
            using var gate = new SemaphoreSlim(8);
            var verdicts = await Task.WhenAll(items.Select(async item =>
            {
                if (item.TmdbId is not > 0)
                {
                    return false; // unverifiable for a restricted user: hidden
                }

                try
                {
                    await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                    try
                    {
                        return !await _access.IsTitleBlockedAsync(item.MediaType, item.TmdbId.Value, caller, budget.Token).ConfigureAwait(false);
                    }
                    finally
                    {
                        gate.Release();
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    pending = true;
                    return false;
                }
            })).ConfigureAwait(false);
            for (var i = 0; i < items.Count; i++)
            {
                if (verdicts[i])
                {
                    allowed.Add(items[i]);
                }
            }

            return (allowed, pending);
        }

        // ── Link / unlink ───────────────────────────────────────────────────

        /// <summary>Validates a URL and decides the provider (fetches once — cached — to check the list is readable).</summary>
        /// <param name="caller">The user linking.</param>
        /// <param name="url">URL.</param>
        /// <param name="syncEnabled">Keep in sync.</param>
        /// <param name="removeDropped">Remove dropped entries.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The spec, or an error outcome.</returns>
        public async Task<(SourceLinkSpec? Spec, ListOutcome? Error)> PrepareLinkAsync(User caller, string? url, bool syncEnabled, bool removeDropped, CancellationToken cancellationToken)
        {
            if (!ListSourceUrl.TryParse(url, out var source, out var parseError))
            {
                return (null, ParseFailure(parseError));
            }

            var result = await _fetcher.FetchAsync(source!, new SourceFetchOptions { AllowMdblistApi = ListAccessService.IsAdmin(caller) }, cancellationToken).ConfigureAwait(false);
            if (!result.Ok)
            {
                return (null, FetchFailure(result));
            }

            return (new SourceLinkSpec(result.Kind, result.CanonicalUrl, result.Provider, result.Title, syncEnabled, removeDropped), null);
        }

        /// <summary>
        /// B10 for URL imports: the stored response of a retried POST /{listId}/apply or /playlists|/collections, checked
        /// BEFORE the source is fetched again (a replay must not depend on the list site being reachable).
        /// </summary>
        /// <param name="scope">Replay scope: the list id ("N") for apply, <c>create-&lt;kind&gt;</c> for create.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="userIdN">Caller ("N").</param>
        /// <returns>The stored outcome, or null.</returns>
        public ListOutcome? TryReplayImport(string scope, string? requestId, string userIdN) =>
            requestId != null && _store.TryGetReplay(scope, requestId, userIdN, out var replay)
                ? new ListOutcome { StatusCode = replay.StatusCode, RawJson = replay.Body }
                : null;

        /// <summary>PUT /{listId}/source: links (or re-links) the list; the next sync (or "Sync now") adds entries.</summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The fresh view.</returns>
        public async Task<ListOutcome> LinkAsync(ListAccess access, LinkSourceRequest request, CancellationToken cancellationToken)
        {
            if (request.RequestId != null && _store.TryGetReplay(access.ListIdN + "-source", request.RequestId, access.UserIdN, out var replay))
            {
                return new ListOutcome { StatusCode = replay.StatusCode, RawJson = replay.Body };
            }

            var (spec, error) = await PrepareLinkAsync(access.User, request.Url, request.SyncEnabled, request.RemoveDropped, cancellationToken).ConfigureAwait(false);
            if (error != null)
            {
                return error;
            }

            using (await _store.LockAsync(access.ListIdN, cancellationToken).ConfigureAwait(false))
            {
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                ApplyLink(doc, spec!, access.UserIdN, DateTime.UtcNow);
                _store.Save(doc);
            }

            _logger.Info($"[ListPlaceholders] {access.User.Username} linked list {access.ListIdN} to {spec!.Url} (sync {(spec.SyncEnabled ? "on" : "off")}, removeDropped {(spec.RemoveDropped ? "on" : "off")}).");
            var view = await _lists.GetViewAsync(access, cancellationToken).ConfigureAwait(false);
            Remember(access, request.RequestId, view);
            return ListOutcome.Ok(view);
        }

        /// <summary>DELETE /{listId}/source: unlinks (entries stay; provenance is dropped).</summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The fresh view.</returns>
        public async Task<ListOutcome> UnlinkAsync(ListAccess access, string? requestId, CancellationToken cancellationToken)
        {
            if (requestId != null && _store.TryGetReplay(access.ListIdN + "-source", requestId, access.UserIdN, out var replay))
            {
                return new ListOutcome { StatusCode = replay.StatusCode, RawJson = replay.Body };
            }

            using (await _store.LockAsync(access.ListIdN, cancellationToken).ConfigureAwait(false))
            {
                var current = _store.Load(access.ListIdN);
                if (current?.Source != null)
                {
                    var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                    doc.Source = null;
                    _store.Save(doc);
                    _logger.Info($"[ListPlaceholders] {access.User.Username} unlinked list {access.ListIdN}.");
                }
            }

            var view = await _lists.GetViewAsync(access, cancellationToken).ConfigureAwait(false);
            Remember(access, requestId, view);
            return ListOutcome.Ok(view);
        }

        /// <summary>
        /// Same-write provenance for an import that came from a URL (POST /{listId}/apply or /playlists with
        /// <c>source</c>): links the list, records the entries the import added as sync-owned, makes the fetched keys the
        /// first snapshot and tombstones the keys the editor skipped in review.
        /// </summary>
        /// <param name="spec">Prepared link.</param>
        /// <param name="linkedBy">Importing user ("N").</param>
        /// <param name="entryKeys">Source key per entry index.</param>
        /// <param name="snapshotKeys">Keys of the complete fetched list (from the client; validated).</param>
        /// <returns>Hooks for the apply.</returns>
        public static ApplyHooks ImportHooks(SourceLinkSpec spec, string linkedBy, IReadOnlyDictionary<int, string> entryKeys, IReadOnlyList<string> snapshotKeys)
        {
            // A failed apply (Jellyfin threw part-way) records the same way with what did land: the list is linked and
            // owns it, so the same-requestId retry (which skips those placeholders as duplicates) or the next sync
            // treats them as imported; entries that didn't land were sent, so they are neither declined nor handled.
            bool Record(ListDoc doc, ApplyResultDto result, IReadOnlyList<ApplyEntry> applied, bool failed)
            {
                var now = DateTime.UtcNow;
                ApplyLink(doc, spec, linkedBy, now);
                var source = doc.Source!;
                var accounted = RecordApplyResult(doc, applied, entryKeys, result);
                var snapshot = snapshotKeys.Where(SourceKeys.IsValid).Distinct(StringComparer.Ordinal).ToList();
                var sent = new HashSet<string>(entryKeys.Values, StringComparer.Ordinal);
                // Rows the editor skipped in review are a decision: never add them back.
                ListSourceProvenance.Decline(source, snapshot.Where(k => !accounted.Contains(k) && !sent.Contains(k)), now);
                source.LastSnapshotKeys = snapshot.Where(k => accounted.Contains(k) || source.UserRemovedKeys.ContainsKey(k)).ToList();
                ListSourceProvenance.Prune(source, now);
                var added = result.Added.Count + result.AddedAsItems.Count;
                source.LastSyncAt = now.ToString("o", CultureInfo.InvariantCulture);
                source.LastSyncResult = failed ? $"The import stopped part-way (Jellyfin could not update the list); imported {added}" : $"Imported {added}";
                source.LastSync = failed
                    ? new SourceSyncSummary { State = "failed", Code = "apply_failed", Added = added }
                    : new SourceSyncSummary { State = "imported", Added = added };
                return true;
            }

            return new ApplyHooks
            {
                AfterApplyAsync = (doc, result, applied) => Task.FromResult(Record(doc, result, applied, failed: false)),
                AfterFailedApply = (doc, result, applied) => Record(doc, result, applied, failed: true),
            };
        }

        // Records owned entries of an apply; returns the keys it accounted for (added, already present or blocked).
        // `applied` are the entries after C1 expansion, so a key owns everything its entry turned into: the placeholder
        // and/or the real items JE added for it (an in-library movie, the present episodes of a TV scope, a collection's
        // Season / Series item). Items that were already in the list stay "present" (F1) — unless another key of this
        // source owns them (overlapping scopes: "Show S1" and "Show S1E1", a series and its season, or two ids of one
        // title): then this key shares the ownership, so the entry is removed only once EVERY key that wants it left
        // the source (PlanDrops keeps what a current key still owns).
        private static HashSet<string> RecordApplyResult(ListDoc doc, IReadOnlyList<ApplyEntry> applied, IReadOnlyDictionary<int, string> entryKeys, ApplyResultDto result)
        {
            var source = doc.Source!;
            var accounted = new HashSet<string>(StringComparer.Ordinal);
            var added = new HashSet<string>(result.Added, StringComparer.Ordinal);
            var addedItems = new HashSet<string>(result.AddedAsItems, StringComparer.Ordinal);
            var skipped = result.Skipped.GroupBy(s => s.Index).ToDictionary(g => g.Key, g => g.First().Reason);
            var notAdded = new List<(ApplyEntry Entry, string Key)>();
            foreach (var entry in applied)
            {
                if (!entryKeys.TryGetValue(entry.Index, out var key))
                {
                    continue;
                }

                if (entry.Placeholder != null && added.Contains(entry.Placeholder.Id))
                {
                    ListSourceProvenance.RecordAdded(source, key, entry.Placeholder.Id, null);
                    accounted.Add(key);
                }
                else if (entry.ItemId.HasValue && addedItems.Contains(entry.ItemId.Value.ToString("N", CultureInfo.InvariantCulture)))
                {
                    ListSourceProvenance.RecordAdded(source, key, null, entry.ItemId.Value.ToString("N", CultureInfo.InvariantCulture));
                    accounted.Add(key);
                }
                else
                {
                    notAdded.Add((entry, key));
                    if (skipped.TryGetValue(entry.Index, out var reason) && reason is "duplicate" or "alreadyInList" or "blocked")
                    {
                        accounted.Add(key); // present (or not allowed): never re-tried
                    }
                }
            }

            // Second pass, once this apply's own additions are recorded: present entries another key owns are shared.
            foreach (var (entry, key) in notAdded)
            {
                if (entry.ItemId.HasValue)
                {
                    var itemId = entry.ItemId.Value.ToString("N", CultureInfo.InvariantCulture);
                    if (OwnedByOtherKey(source, key, o => o.ItemIds.Contains(itemId, StringComparer.Ordinal)))
                    {
                        ListSourceProvenance.RecordAdded(source, key, null, itemId);
                    }
                }
                else if (entry.Placeholder != null && !(source.Owned.TryGetValue(key, out var mine) && mine.PhId != null))
                {
                    var identity = PlaceholderRules.IdentityKey(entry.Placeholder);
                    var existing = doc.Items.FirstOrDefault(p => p.Id != entry.Placeholder.Id && string.Equals(PlaceholderRules.IdentityKey(p), identity, StringComparison.Ordinal));
                    if (existing != null && OwnedByOtherKey(source, key, o => o.PhId == existing.Id))
                    {
                        ListSourceProvenance.RecordAdded(source, key, existing.Id, null);
                    }
                }
            }

            return accounted;
        }

        private static bool OwnedByOtherKey(ListSource source, string key, Func<SourceOwnership, bool> owns) =>
            source.Owned.Any(o => !string.Equals(o.Key, key, StringComparison.Ordinal) && owns(o.Value));

        private static void ApplyLink(ListDoc doc, SourceLinkSpec spec, string linkedBy, DateTime now)
        {
            var old = doc.Source;
            var generation = NextGeneration(old?.Generation ?? 0, now);
            if (old != null && string.Equals(old.Url, spec.Url, StringComparison.Ordinal))
            {
                old.Kind = spec.Kind;
                old.Provider = spec.Provider;
                old.Title = spec.Title ?? old.Title;
                old.SyncEnabled = spec.SyncEnabled;
                old.RemoveDropped = spec.RemoveDropped;
                old.LinkedByUserId = linkedBy;
                old.Generation = generation;
                old.PausedReason = null;
                old.PausedCode = null;
                return;
            }

            doc.Source = new ListSource
            {
                Kind = spec.Kind,
                Provider = spec.Provider,
                Url = spec.Url,
                Title = spec.Title,
                SyncEnabled = spec.SyncEnabled,
                RemoveDropped = spec.RemoveDropped,
                LinkedByUserId = linkedBy,
                Generation = generation,
            };
        }

        // Generations never repeat across unlink/relink, so a running sync of an old link can't match a new one: they
        // are seeded from the clock (seconds since 2020, so they also grow across restarts) and strictly increase within
        // the process — the only place a sync of an earlier link can still be running — even within one second.
        internal static int NextGeneration(int previous, DateTime now)
        {
            var seed = (int)Math.Min(int.MaxValue - 1_000_000, (now - new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds);
            while (true)
            {
                var last = Volatile.Read(ref _lastGeneration);
                var next = Math.Max(Math.Max(previous, last) + 1, seed);
                if (Interlocked.CompareExchange(ref _lastGeneration, next, last) == last)
                {
                    return next;
                }
            }
        }

        // ── Sync ────────────────────────────────────────────────────────────

        /// <summary>POST /{listId}/source/sync: runs a sync now (interactive priority); 202 when it is still running after <see cref="SyncNowWait"/>.</summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Request aborted (the sync itself continues).</param>
        /// <returns>The sync result with the fresh view.</returns>
        public async Task<ListOutcome> SyncNowAsync(ListAccess access, string? requestId, CancellationToken cancellationToken)
        {
            if (requestId != null && _store.TryGetReplay(access.ListIdN + "-sync", requestId, access.UserIdN, out var replay))
            {
                return new ListOutcome { StatusCode = replay.StatusCode, RawJson = replay.Body };
            }

            if (_store.Load(access.ListIdN)?.Source == null)
            {
                return ListOutcome.Error(404, "no_source", "This list isn't linked to a source.");
            }

            var task = SyncAsync(access.ListIdN, background: false, CancellationToken.None);
            var finished = await Task.WhenAny(task, Task.Delay(SyncNowWait, cancellationToken)).ConfigureAwait(false);
            if (finished != task)
            {
                return new ListOutcome { StatusCode = 202, Value = new SourceSyncResultDto { State = "running", Message = "The sync is still running; reload the list in a moment." } };
            }

            SourceSyncResultDto shared;
            try
            {
                shared = await task.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // Joined a scheduled sync that was cancelled (task stopped, server shutting down): not this request's fault.
                return new ListOutcome { StatusCode = 202, Value = new SourceSyncResultDto { State = "running", Code = "cancelled", Message = "The sync was interrupted; try again in a moment." } };
            }

            // Joined callers share one result: give each its own copy with its own (per-user filtered) view.
            var result = CopyForCaller(shared);
            result.View = await _lists.GetViewAsync(access, cancellationToken).ConfigureAwait(false);
            if (result.View?.Source == null || result.View.Source.CountsHidden == true)
            {
                // A2: the counts describe the whole list; a caller who doesn't see every entry gets only the outcome.
                HideCounts(result);
            }
            if (requestId != null)
            {
                _store.RememberReplay(access.ListIdN + "-sync", requestId, access.UserIdN, 200, JsonSerializer.Serialize(result, ReplayJson));
            }

            return ListOutcome.Ok(result);
        }

        private static void HideCounts(SourceSyncResultDto result)
        {
            result.Added = 0;
            result.Removed = 0;
            result.Kept = 0;
            result.Unresolved = 0;
            result.ListFull = false;
            result.CountsHidden = true;
            if (result.State == "ok")
            {
                result.Message = "Synced.";
            }
        }

        private static SourceSyncResultDto CopyForCaller(SourceSyncResultDto shared) => new()
        {
            State = shared.State,
            Code = shared.Code,
            Added = shared.Added,
            Removed = shared.Removed,
            Kept = shared.Kept,
            Unresolved = shared.Unresolved,
            ListFull = shared.ListFull,
            Message = shared.Message,
        };

        /// <summary>The scheduled sync: every linked list with sync on and not paused, one after another, at background priority.</summary>
        /// <param name="progress">Progress.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>A task.</returns>
        public async Task SyncAllAsync(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            var ids = _store.EnumerateListIds();
            var done = 0;
            foreach (var listIdN in ids)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ListDoc? doc;
                try
                {
                    doc = _store.Load(listIdN);
                }
                catch (System.IO.InvalidDataException)
                {
                    doc = null;
                }

                if (doc?.Source is { SyncEnabled: true, PausedReason: null })
                {
                    try
                    {
                        var result = await SyncAsync(listIdN, background: true, cancellationToken).ConfigureAwait(false);
                        _logger.Info($"[ListPlaceholders] Scheduled sync of list {listIdN}: {result.State} — {result.Message}");
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        _logger.Error($"[ListPlaceholders] Scheduled sync of list {listIdN} failed: {ex.Message}");
                    }
                }

                progress?.Report(100.0 * ++done / Math.Max(1, ids.Count));
            }
        }

        /// <summary>Runs one sync of a list (single-flight per list).</summary>
        /// <param name="listIdN">List id.</param>
        /// <param name="background">Scheduled (lower priority) or interactive.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The result.</returns>
        public Task<SourceSyncResultDto> SyncAsync(string listIdN, bool background, CancellationToken cancellationToken)
        {
            var mine = new TaskCompletionSource<SourceSyncResultDto>(TaskCreationOptions.RunContinuationsAsynchronously);
            var running = _running.GetOrAdd(listIdN, mine.Task);
            if (!ReferenceEquals(running, mine.Task))
            {
                return running;
            }

            _ = RunAsync();
            return mine.Task;

            async Task RunAsync()
            {
                try
                {
                    mine.TrySetResult(await SyncCoreAsync(listIdN, background, cancellationToken).ConfigureAwait(false));
                }
                catch (OperationCanceledException ex)
                {
                    mine.TrySetCanceled(ex.CancellationToken);
                }
                catch (Exception ex)
                {
                    _logger.Error($"[ListPlaceholders] Sync of list {listIdN} failed: {ex.Message}");
                    mine.TrySetResult(new SourceSyncResultDto { State = "failed", Message = "The sync failed; see the server log." });
                }
                finally
                {
                    _running.TryRemove(new KeyValuePair<string, Task<SourceSyncResultDto>>(listIdN, mine.Task));
                }
            }
        }

        private async Task<SourceSyncResultDto> SyncCoreAsync(string listIdN, bool background, CancellationToken cancellationToken)
        {
            var doc = _store.Load(listIdN);
            var source = doc?.Source;
            if (source == null)
            {
                return new SourceSyncResultDto { State = "failed", Message = "This list isn't linked to a source." };
            }

            var generation = source.Generation;
            var url = source.Url;
            var list = _host.GetList(Guid.ParseExact(listIdN, "N"));
            if (list == null)
            {
                return new SourceSyncResultDto { State = "failed", Message = "The list no longer exists." };
            }

            if (source.PausedReason != null)
            {
                return new SourceSyncResultDto { State = "paused", Code = source.PausedCode, Message = source.PausedReason };
            }

            // F3: the sync acts as the user who linked the source, while they can still edit the list.
            var linkedById = Guid.TryParse(source.LinkedByUserId, out var parsedLinker) ? parsedLinker : Guid.Empty;
            var access = EvaluateLinker(list.Id, linkedById, out var linkerMissing);
            if (access == null || !access.Permissions.CanEdit)
            {
                return await PauseAsync(listIdN, list.Kind, generation, linkerMissing ? LinkerMissing : LinkerCannotEdit, cancellationToken).ConfigureAwait(false);
            }

            var linkedBy = access.User;
            if (!ListSourceUrl.TryParse(url, out var parsed, out _))
            {
                return await PauseAsync(listIdN, list.Kind, generation, UrlUnsupported, cancellationToken).ConfigureAwait(false);
            }

            var fetched = await _fetcher.FetchAsync(parsed!, new SourceFetchOptions { AllowMdblistApi = ListAccessService.IsAdmin(linkedBy), Provider = source.Provider, Fresh = true }, cancellationToken).ConfigureAwait(false);
            if (!fetched.Ok)
            {
                // F2: never act on a failed fetch — only record it.
                var message = "Couldn't read the source: " + fetched.Message;
                var code = fetched.ErrorCode ?? "upstream_error";
                await RecordFailureAsync(listIdN, list.Kind, generation, code, message, cancellationToken).ConfigureAwait(false);
                return new SourceSyncResultDto { State = "failed", Code = code, Message = message };
            }

            var items = new List<SourceItem>();
            var keys = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var duplicates = 0;
            var noId = 0;
            foreach (var item in fetched.Items)
            {
                var key = item.Key;
                if (key == null)
                {
                    noId++;
                }
                else if (!seen.Add(key))
                {
                    duplicates++;
                }
                else
                {
                    items.Add(item);
                    keys.Add(key);
                }
            }

            var toAdd = ListSourceProvenance.KeysToAdd(source, keys);
            if (toAdd.Count > 0 && !_resolver.IsAvailable)
            {
                const string unavailable = "Seerr isn't set up, so new entries can't be looked up; nothing was synced.";
                await RecordFailureAsync(listIdN, list.Kind, generation, "seerr_unavailable", unavailable, cancellationToken).ConfigureAwait(false);
                return new SourceSyncResultDto { State = "failed", Code = "seerr_unavailable", Message = unavailable };
            }

            var byKey = items.ToDictionary(i => i.Key!, StringComparer.Ordinal);
            var (entries, entryKeys, unaccounted) = await BuildEntriesAsync(access, toAdd.Select(k => byKey[k]).ToList(), listIdN, background, cancellationToken).ConfigureAwait(false);

            // F3 again: fetching and resolving can take minutes, during which the linker may have lost edit rights.
            access = EvaluateLinker(list.Id, linkedById, out linkerMissing);
            if (access == null || !access.Permissions.CanEdit)
            {
                return await PauseAsync(listIdN, list.Kind, generation, linkerMissing ? LinkerMissing : LinkerCannotEdit, cancellationToken).ConfigureAwait(false);
            }

            // F2: a truncated or partial snapshot may lack entries that are still in the source: add, never remove.
            var complete = !fetched.Truncated && !fetched.Partial;
            var stats = new SourceSyncResultDto { Unresolved = unaccounted.Count };
            string? pausedCode = null;
            var hooks = new ApplyHooks
            {
                // Under the list lock: the same link, and the linker can still edit (else the link pauses, nothing applies).
                Precondition = d =>
                {
                    if (d.Source == null || d.Source.Generation != generation || !string.Equals(d.Source.Url, url, StringComparison.Ordinal))
                    {
                        return "source_changed";
                    }

                    return EvaluateLinker(list.Id, linkedById, out _)?.Permissions.CanEdit == true ? null : LinkerCannotEdit;
                },
                AfterApplyAsync = async (d, result, applied) =>
                {
                    var now = DateTime.UtcNow;
                    var src = d.Source!;
                    var occurrences = ListSourceProvenance.Occurrences(_host.GetRawEntries(list.Id));
                    ListSourceProvenance.DetectUserRemovals(d, occurrences, now);
                    var accounted = RecordApplyResult(d, applied, entryKeys, result);
                    stats.ListFull = result.Skipped.Any(s => s.Reason == "listFull");

                    var missed = new HashSet<string>(unaccounted, StringComparer.Ordinal);
                    foreach (var key in entryKeys.Values.Where(k => !accounted.Contains(k)))
                    {
                        missed.Add(key);
                    }

                    if (complete)
                    {
                        var plan = ListSourceProvenance.PlanDrops(d, keys, occurrences);
                        if (plan.Any && await HiddenFromLinkerAsync(d, plan, access.User, cancellationToken).ConfigureAwait(false))
                        {
                            // F3: the sync acts as the linker, who must still see what it removes; else nothing is removed
                            // and the link pauses (what was added passed the linker's own checks).
                            pausedCode = LinkerCannotSee;
                            plan = new DropPlan();
                        }

                        var removedItems = new List<string>();
                        if (plan.ItemIds.Count > 0)
                        {
                            try
                            {
                                await _remover.RemoveAsync(list, plan.ItemIds).ConfigureAwait(false);
                                var after = ListSourceProvenance.Occurrences(_host.GetRawEntries(list.Id));
                                removedItems.AddRange(plan.ItemIds.Select(id => id.ToString("N", CultureInfo.InvariantCulture)).Where(id => !after.ContainsKey(id)));
                            }
                            catch (Exception ex)
                            {
                                _logger.Warning($"[ListPlaceholders] Removing dropped entries from list {listIdN} failed: {ex.Message}");
                            }
                        }

                        stats.Removed = ListSourceProvenance.ApplyDrops(d, plan, removedItems);
                        stats.Kept = plan.Kept;
                        src.LastSnapshotKeys = keys.Where(k => !missed.Contains(k)).ToList();
                    }
                    else
                    {
                        // Incomplete snapshot (over the cap, or a partial answer): add, never remove; remember what was handled.
                        src.LastSnapshotKeys = src.LastSnapshotKeys.Concat(keys.Where(k => !missed.Contains(k))).Distinct(StringComparer.Ordinal).ToList();
                    }

                    stats.Added = result.Added.Count + result.AddedAsItems.Count;
                    stats.Unresolved = missed.Count;
                    ListSourceProvenance.Prune(src, now);
                    src.LastSyncAt = now.ToString("o", CultureInfo.InvariantCulture);
                    if (pausedCode != null)
                    {
                        var reason = PauseReason(pausedCode);
                        src.PausedReason = reason;
                        src.PausedCode = pausedCode;
                        src.LastSyncResult = "Paused: " + reason;
                        src.LastSync = new SourceSyncSummary { State = "paused", Code = pausedCode, Added = stats.Added };
                        stats.Message = reason;
                        return true;
                    }

                    src.LastSyncResult = Summary(stats, duplicates, noId, fetched.Truncated, fetched.Partial);
                    src.LastSync = new SourceSyncSummary
                    {
                        State = "ok",
                        Added = stats.Added,
                        Removed = stats.Removed,
                        Kept = stats.Kept,
                        Unresolved = stats.Unresolved + noId,
                        Duplicates = duplicates,
                        ListFull = stats.ListFull,
                        Truncated = fetched.Truncated,
                        Partial = fetched.Partial,
                    };
                    stats.Message = src.LastSyncResult;
                    return true;
                },
                // Jellyfin failed part-way: own what landed (the failure itself is recorded below), so the next sync
                // doesn't find those entries again as hand-added duplicates.
                AfterFailedApply = (d, result, applied) =>
                {
                    RecordApplyResult(d, applied, entryKeys, result);
                    return true;
                },
            };

            var outcome = await _lists.ApplyAsync(access, entries, null, null, null, cancellationToken, hooks).ConfigureAwait(false);
            if (outcome.StatusCode == 409 && (outcome.Value as ListErrorDto)?.Code == LinkerCannotEdit)
            {
                EvaluateLinker(list.Id, linkedById, out linkerMissing);
                return await PauseAsync(listIdN, list.Kind, generation, linkerMissing ? LinkerMissing : LinkerCannotEdit, cancellationToken).ConfigureAwait(false);
            }

            if (outcome.StatusCode == 409)
            {
                return new SourceSyncResultDto { State = "failed", Code = "source_changed", Message = "The link changed while syncing; nothing was applied." };
            }

            if (outcome.StatusCode >= 300)
            {
                var error = outcome.Value as ListErrorDto;
                var message = "The sync couldn't update the list: " + (error?.Message ?? "unknown error");
                await RecordFailureAsync(listIdN, list.Kind, generation, "apply_failed", message, cancellationToken).ConfigureAwait(false);
                return new SourceSyncResultDto { State = "failed", Code = "apply_failed", Message = message };
            }

            if (pausedCode != null)
            {
                _logger.Warning($"[ListPlaceholders] Paused the linked source of list {listIdN}: {stats.Message}");
                stats.State = "paused";
                stats.Code = pausedCode;
                return stats;
            }

            _logger.Info($"[ListPlaceholders] Synced list {listIdN} from {url}: {stats.Message}");
            stats.State = "ok";
            return stats;
        }

        private async Task<(List<ApplyEntry> Entries, Dictionary<int, string> Keys, List<string> Unaccounted)> BuildEntriesAsync(ListAccess access, IReadOnlyList<SourceItem> items, string listIdN, bool background, CancellationToken cancellationToken)
        {
            var entries = new List<ApplyEntry>();
            var keys = new Dictionary<int, string>();
            var unaccounted = new List<string>();
            if (items.Count == 0)
            {
                return (entries, keys, unaccounted);
            }

            if (!_resolver.IsAvailable)
            {
                unaccounted.AddRange(items.Select(i => i.Key!));
                return (entries, keys, unaccounted);
            }

            var users = new List<User> { access.User };
            if (access.List.Kind == ListKinds.Playlist && access.Owner != null && access.Owner.Id != access.User.Id)
            {
                users.Add(access.Owner);
            }

            var context = new ImportCallContext("sync:" + listIdN, background);
            var isPlaylist = access.List.Kind == ListKinds.Playlist;
            for (var start = 0; start < items.Count; start += ListImportResolver.MaxEntriesPerCall)
            {
                var chunk = items.Skip(start).Take(ListImportResolver.MaxEntriesPerCall).ToList();
                var outcome = await _resolver.ResolveAsync(
                    chunk.Select((item, i) => ToEntry(item, start + i)).ToList(),
                    new ImportResolveOptions { Caller = access.User, LibraryUsers = users, Context = context, Parental = false, Deadline = SyncChunkDeadline },
                    cancellationToken).ConfigureAwait(false);
                foreach (var resolved in outcome.Response.Results)
                {
                    var item = items[resolved.Index];
                    var key = item.Key!;
                    var match = resolved.Match;
                    // Nobody reviews a sync: only confident matches (source ids, or title + year) are added.
                    if (resolved.State != "ok" || match == null || resolved.Confidence != ImportScoring.Levels.High)
                    {
                        unaccounted.Add(key);
                        continue;
                    }

                    var kind = item.Episode.HasValue ? PlaceholderKinds.Episodes : item.Season.HasValue ? PlaceholderKinds.Season : item.MediaType == "tv" ? PlaceholderKinds.Series : PlaceholderKinds.Movie;
                    var index = entries.Count;
                    // A movie (or, in a collection, a whole series) in the library goes in as its item. Every TV scope
                    // is sent as a placeholder: the apply's C1 expansion puts what the library has in as real items
                    // (playlists: the present episodes in order; collections: the Season / Episode items) and keeps the
                    // placeholder, with `filled`, for the rest. The ownership of both is recorded under this key.
                    var library = match.InLibrary;
                    if (library != null && Guid.TryParse(library.ItemId, out var itemId)
                        && (kind == PlaceholderKinds.Movie || (!isPlaylist && kind == PlaceholderKinds.Series)))
                    {
                        entries.Add(new ApplyEntry(index, itemId, null));
                        keys[index] = key;
                        continue;
                    }

                    var dto = ImportPlaceholders.FromCandidate(match, kind, item.Season, item.Episode.HasValue ? new[] { item.Episode.Value } : null, item.Note);
                    if (dto == null || !PlaceholderRules.TryCreate(dto, access.UserIdN, DateTime.UtcNow, out var placeholder, out _))
                    {
                        unaccounted.Add(key);
                        continue;
                    }

                    placeholder.SourceKey = key;
                    entries.Add(new ApplyEntry(index, null, placeholder));
                    keys[index] = key;
                }
            }

            return (entries, keys, unaccounted);
        }

        // F3: whether anything a drop plan would remove is hidden from the linker (an item they can no longer access, or a
        // placeholder their parental filter now hides). Fails closed.
        private async Task<bool> HiddenFromLinkerAsync(ListDoc doc, DropPlan plan, User linker, CancellationToken cancellationToken)
        {
            try
            {
                if (plan.ItemIds.Any(id => !_host.CanAccessItem(id, linker)))
                {
                    return true;
                }

                var drop = new HashSet<string>(plan.PlaceholderIds, StringComparer.Ordinal);
                var placeholders = doc.Items.Where(p => drop.Contains(p.Id)).ToList();
                return placeholders.Count > 0 && (await _access.GetHiddenPlaceholderIdsAsync(placeholders, linker, cancellationToken).ConfigureAwait(false)).Count > 0;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[ListPlaceholders] Checking what the linker of list {doc.ListId} can see failed: {ex.Message}");
                return true;
            }
        }

        // The linker's current access to the list (null when the list or the user is gone).
        private ListAccess? EvaluateLinker(Guid listId, Guid linkedById, out bool linkerMissing)
        {
            var user = linkedById == Guid.Empty ? null : _users.GetUserById(linkedById);
            linkerMissing = user == null;
            var list = _host.GetList(listId);
            return user == null || list == null ? null : _access.Evaluate(list, user);
        }

        private static string Summary(SourceSyncResultDto stats, int duplicates, int noId, bool truncated, bool partial)
        {
            var parts = new List<string> { $"Added {stats.Added.ToString(CultureInfo.InvariantCulture)}" };
            if (stats.Removed > 0)
            {
                parts.Add($"removed {stats.Removed.ToString(CultureInfo.InvariantCulture)}");
            }

            if (stats.Kept > 0)
            {
                parts.Add($"kept {stats.Kept.ToString(CultureInfo.InvariantCulture)} that left the list (not added by sync)");
            }

            if (stats.Unresolved + noId > 0)
            {
                parts.Add($"{(stats.Unresolved + noId).ToString(CultureInfo.InvariantCulture)} not found");
            }

            if (duplicates > 0)
            {
                parts.Add($"{duplicates.ToString(CultureInfo.InvariantCulture)} duplicates ignored");
            }

            if (stats.ListFull)
            {
                parts.Add("list full");
            }

            if (truncated)
            {
                parts.Add($"only the first {ListSourceFetcher.MaxItems.ToString(CultureInfo.InvariantCulture)} entries are synced");
            }

            if (partial)
            {
                parts.Add("the source answered only partly, so nothing was removed");
            }

            return string.Join(", ", parts) + ".";
        }

        // English fallbacks of the pause codes (shown to every viewer: no user names).
        private static string PauseReason(string code) => code switch
        {
            LinkerMissing => "The user who linked this list no longer exists; link it again.",
            LinkerCannotEdit => "The user who linked this list can no longer edit it; link it again.",
            LinkerCannotSee => "The user who linked this list can no longer see some entries that left the source, so nothing was removed; link it again.",
            _ => "The linked URL is no longer supported.",
        };

        private async Task<SourceSyncResultDto> PauseAsync(string listIdN, string kind, int generation, string code, CancellationToken cancellationToken)
        {
            var reason = PauseReason(code);
            await UpdateSourceAsync(listIdN, kind, generation, s =>
            {
                s.PausedReason = reason;
                s.PausedCode = code;
                s.LastSyncAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                s.LastSyncResult = "Paused: " + reason;
                s.LastSync = new SourceSyncSummary { State = "paused", Code = code };
            }, cancellationToken).ConfigureAwait(false);
            _logger.Warning($"[ListPlaceholders] Paused the linked source of list {listIdN}: {reason}");
            return new SourceSyncResultDto { State = "paused", Code = code, Message = reason };
        }

        private Task RecordFailureAsync(string listIdN, string kind, int generation, string code, string message, CancellationToken cancellationToken) =>
            UpdateSourceAsync(listIdN, kind, generation, s =>
            {
                s.LastSyncAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                s.LastSyncResult = message;
                s.LastSync = new SourceSyncSummary { State = "failed", Code = code };
            }, cancellationToken);

        private async Task UpdateSourceAsync(string listIdN, string kind, int generation, Action<ListSource> mutate, CancellationToken cancellationToken)
        {
            using (await _store.LockAsync(listIdN, cancellationToken).ConfigureAwait(false))
            {
                var current = _store.Load(listIdN);
                if (current?.Source == null || current.Source.Generation != generation)
                {
                    return;
                }

                var doc = _store.LoadForUpdate(listIdN, kind);
                mutate(doc.Source!);
                _store.Save(doc);
            }
        }

        private void Remember(ListAccess access, string? requestId, ListViewDto view)
        {
            if (requestId != null)
            {
                _store.RememberReplay(access.ListIdN + "-source", requestId, access.UserIdN, 200, JsonSerializer.Serialize(view, ReplayJson));
            }
        }

        private static ListOutcome ParseFailure(string? code) => code switch
        {
            ListSourceUrl.LetterboxdUnsupported => ListOutcome.Error(400, code, "Letterboxd doesn't offer an API Jellyfin Enhanced can use. Add the list to MDBList (My Lists → External Lists) and import the MDBList URL, or export the list as CSV on Letterboxd and paste it."),
            ListSourceUrl.InvalidUrl => ListOutcome.Error(400, code, "That isn't a valid list URL."),
            _ => ListOutcome.Error(400, ListSourceUrl.UnsupportedUrl, "Supported list URLs: MDBList, TMDB (lists, collections, charts), Trakt (lists, watchlists, charts) and IMDb (when enabled)."),
        };

        private static ListOutcome FetchFailure(SourceFetchResult result)
        {
            var status = result.ErrorCode switch
            {
                "not_found" => 404,
                "rate_limited" or "quota_exhausted" => 429,
                "timeout" => 504,
                "upstream_error" or "unreachable" or "too_large" => 502,
                _ => 400, // configuration: trakt_not_configured, tmdb_key_required, tmdb_key_invalid, imdb_disabled, trakt_unauthorized
            };
            var outcome = ListOutcome.Error(status, result.ErrorCode ?? "upstream_error", result.Message ?? "The list couldn't be read.");
            return result.RetryAfterSeconds.HasValue ? new ListOutcome { StatusCode = outcome.StatusCode, Value = outcome.Value, RetryAfterSeconds = result.RetryAfterSeconds } : outcome;
        }
    }
}
