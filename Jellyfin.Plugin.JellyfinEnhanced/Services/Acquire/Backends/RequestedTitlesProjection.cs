using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends
{
    /// <summary>An own interest, including its edition and part. A title match never grants episode/copy access.</summary>
    public sealed record RequestedTitle([property: JsonPropertyName("mediaType")] string MediaType,
        [property: JsonPropertyName("tmdbId")] int TmdbId, [property: JsonPropertyName("key")] string Key,
        [property: JsonPropertyName("variant")] string Variant, [property: JsonPropertyName("scope")] string Scope,
        [property: JsonPropertyName("seasons")] IReadOnlyList<int> Seasons, [property: JsonPropertyName("episodes")] IReadOnlyList<RequestEpisode> Episodes);
    /// <summary>Unknown/unavailable is distinct from a complete empty set.</summary>
    public sealed record RequestedTitlesResult([property: JsonPropertyName("available")] bool Available,
        [property: JsonPropertyName("complete")] bool Complete, [property: JsonPropertyName("backend")] string Backend,
        [property: JsonPropertyName("revision")] string Revision, [property: JsonPropertyName("titles")] IReadOnlyList<RequestedTitle> Titles)
    {
        /// <summary>Safe failure category for clients; partial identities remain scoped evidence only.</summary>
        [JsonPropertyName("code")] public string? Code => Available && Complete ? null : "requests_unavailable";
        /// <summary>A later read attempts bounded visibility preparation again.</summary>
        [JsonPropertyName("retryable")] public bool Retryable => !Available || !Complete;
        /// <summary>Compatibility identity set for Downloads/History and Calendar; audience checks still apply.</summary>
        public HashSet<(int TmdbId, string MediaType)> Identities() => Titles.Select(t => (t.TmdbId, t.MediaType)).ToHashSet();
    }
    /// <summary>
    /// Current-user interests from the durable local ledger, independent of request rollout switches.
    /// Uses the existing alias identity and visibility policy, prepares only bounded visibility evidence, never an upstream account.
    /// </summary>
    public sealed class RequestedTitlesProjection
    {
        private readonly ILogger<RequestedTitlesProjection>? _logger;
        private readonly Dictionary<string, DateTime> _diagnostics = new(StringComparer.Ordinal);
        private void Diagnostic(string cause)
        {
            lock (_diagnostics)
            {
                var now = DateTime.UtcNow;
                if (_diagnostics.TryGetValue(cause, out var at) && now - at < TimeSpan.FromMinutes(1)) return;
                _diagnostics[cause] = now;
                _logger?.LogInformation("[RequestsBackend] Requested-title projection unavailable: reason={Reason}", cause);
            }
        }
        private readonly RequestLedger _ledger;
        private readonly TitleAliases _aliases;
        private readonly IRequestPolicy _policy;
        private readonly IArrJellyfinView _view;
        public RequestedTitlesProjection(RequestLedger ledger, TitleAliases aliases, IRequestPolicy policy, IArrJellyfinView view, ILogger<RequestedTitlesProjection>? logger = null)
        { _ledger = ledger; _aliases = aliases; _policy = policy; _view = view; _logger = logger; }
        /// <summary>Reads one person's own interests, not household pending requests, even for an approver.</summary>
        public RequestedTitlesResult ForUser(PluginConfiguration? config, Guid user)
            => ReadAsync(config, user, false, CancellationToken.None).GetAwaiter().GetResult();
        /// <summary>Rewarms cold visibility on every retry, under one two-second budget for the projection.</summary>
        public Task<RequestedTitlesResult> ForUserAsync(PluginConfiguration? config, Guid user, CancellationToken ct = default)
            => ReadAsync(config, user, true, ct);
        private async Task<RequestedTitlesResult> ReadAsync(PluginConfiguration? config, Guid user, bool prepare, CancellationToken ct)
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(TimeSpan.FromSeconds(2));
            var snapshot = EffectiveRequestsBackend.EvaluateConfiguration(config);
            RequestedTitlesResult Unknown(string reason) { Diagnostic(reason); return new(false, false, snapshot.Backend, reason, Array.Empty<RequestedTitle>()); }
            if (config == null || !(snapshot.StrictJe || SharedRequestFacts.LedgerAuthority(config))) return Unknown("backend_unavailable");
            if (_view.Viewer(user) is not { } viewer) return Unknown("user_required");
            if (!_ledger.Database.Available) return Unknown("database_unavailable");
            try
            {
                var before = _ledger.Revision;
                var complete = true;
                var titles = new List<RequestedTitle>();
                var candidates = new List<(RequestedTitle Title, MutationInput Input, MutationInput EvidenceInput, string Target)>();
                var policyRevisions = new List<string>();
                foreach (var want in _ledger.List(user, false).Where(w => w.Status is not ("declined" or "cancelled")))
                {
                    if (TitleKey.Parse(want.Input.Key) is not { } key) { complete = false; continue; }
                    ct.ThrowIfCancellationRequested();
                    var identities = _ledger.AliasesFor(key).SelectMany(k => new[] { k }.Concat(_aliases.Of(k))).DistinctBy(k => k.ToString()).ToArray();
                    // Use a known TMDB identity for absent rating evidence even after live aliases disappear.
                    // The stored destination, edition and requested parts remain the visibility boundary.
                    var tmdb = identities.FirstOrDefault(k => k.Provider == "tmdb")?.NumericId;
                    var input = tmdb is > 0 ? want.Input with { Key = (key.IsMovie ? "movie:tmdb:" : "tv:tmdb:") + tmdb } : want.Input;
                    var facts = _policy.Evaluate(user, want.Input, want.TargetKey);
                    if (facts.VisibilityUnknown) facts = _policy.Evaluate(user, input, want.TargetKey);
                    if (prepare && facts.VisibilityUnknown && !budget.IsCancellationRequested)
                    {
                        try { await _policy.PrepareVisibilityAsync(user, input, budget.Token).WaitAsync(budget.Token).ConfigureAwait(false); }
                        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
                        catch (Exception ex) when (ex is not OperationCanceledException) { Diagnostic("visibility_preparation_failed"); }
                        facts = _policy.Evaluate(user, input, want.TargetKey);
                    }
                    policyRevisions.Add(facts.Revision);
                    if (!facts.Visible) { if (facts.VisibilityUnknown) { complete = false; Diagnostic("visibility_unknown"); } continue; }
                    if (tmdb is not > 0) { complete = false; Diagnostic("identity_unresolved"); continue; }
                    candidates.Add((new(key.IsMovie ? "movie" : "tv", tmdb.Value, _ledger.CanonicalKey(key.Title.ToString()),
                        want.Input.Variant, want.Input.Scope, want.Input.SeasonNumbers.ToArray(), want.Input.Episodes.ToArray()), want.Input, input, want.TargetKey));
                }
                // Later evidence preparation may have awaited while an earlier candidate's access changed.
                // Recheck every returned row after the last await; a changed ledger grants no stale ownership.
                foreach (var candidate in candidates)
                {
                    var facts = _policy.Evaluate(user, candidate.Input, candidate.Target);
                    if (facts.VisibilityUnknown) facts = _policy.Evaluate(user, candidate.EvidenceInput, candidate.Target);
                    policyRevisions.Add(facts.Revision);
                    if (facts.Visible) titles.Add(candidate.Title);
                    else if (facts.VisibilityUnknown) complete = false;
                }
                var after = _ledger.Revision;
                if (before != after) { titles.Clear(); Diagnostic("ledger_changed"); }
                return new(true, complete && before == after, snapshot.Backend, MutationInput.Hash($"{after}|{snapshot.Backend}|{snapshot.IsolationVersion}|{_view.Revision}|{viewer.PolicyRevision}|{string.Join("|", policyRevisions)}|{JsonSerializer.Serialize(titles)}"),
                    titles.OrderBy(t => t.MediaType, StringComparer.Ordinal).ThenBy(t => t.TmdbId).ThenBy(t => t.Variant, StringComparer.Ordinal).ThenBy(t => t.Scope, StringComparer.Ordinal).ToArray());
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception) { return Unknown("projection_unavailable"); }
        }
    }
}
