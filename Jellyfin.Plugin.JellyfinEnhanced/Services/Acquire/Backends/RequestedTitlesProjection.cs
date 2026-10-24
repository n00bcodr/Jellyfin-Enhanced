using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
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
        /// <summary>Compatibility identity set for Downloads/History and Calendar; audience checks still apply.</summary>
        public HashSet<(int TmdbId, string MediaType)> Identities() => Titles.Select(t => (t.TmdbId, t.MediaType)).ToHashSet();
    }
    /// <summary>
    /// Current-user interests from the durable local ledger, independent of request rollout switches.
    /// Uses the existing alias identity and visibility policy, never prepares an upstream account or reads HTTP.
    /// </summary>
    public sealed class RequestedTitlesProjection
    {
        private readonly RequestLedger _ledger;
        private readonly TitleAliases _aliases;
        private readonly IRequestPolicy _policy;
        private readonly IArrJellyfinView _view;
        public RequestedTitlesProjection(RequestLedger ledger, TitleAliases aliases, IRequestPolicy policy, IArrJellyfinView view)
        { _ledger = ledger; _aliases = aliases; _policy = policy; _view = view; }
        /// <summary>Reads one person's own interests, not household pending requests, even for an approver.</summary>
        public RequestedTitlesResult ForUser(PluginConfiguration? config, Guid user)
        {
            var snapshot = EffectiveRequestsBackend.EvaluateConfiguration(config);
            RequestedTitlesResult Unknown(string reason) => new(false, false, snapshot.Backend, reason, Array.Empty<RequestedTitle>());
            if (config == null || !(snapshot.StrictJe || SharedRequestFacts.LedgerAuthority(config))) return Unknown("backend_unavailable");
            if (_view.Viewer(user) is not { } viewer) return Unknown("user_required");
            if (!_ledger.Database.Available) return Unknown("database_unavailable");
            try
            {
                var before = _ledger.Revision;
                var complete = true;
                var titles = new List<RequestedTitle>();
                var policyRevisions = new List<string>();
                foreach (var want in _ledger.List(user, false).Where(w => w.Status is not ("declined" or "cancelled")))
                {
                    if (TitleKey.Parse(want.Input.Key) is not { } key) { complete = false; continue; }
                    // Read-only visibility still evaluates native/library/edition/scope gates with submission off.
                    // No PrepareAsync: it can import users or fetch remote metadata. Unknown evidence stays hidden.
                    var facts = _policy.Evaluate(user, want.Input);
                    policyRevisions.Add(facts.Revision);
                    if (!facts.Visible) { if (facts.VisibilityUnknown) complete = false; continue; }
                    var tmdb = new[] { key.Title }.Concat(_aliases.Of(key)).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId;
                    if (tmdb is not > 0) { complete = false; continue; }
                    titles.Add(new(key.IsMovie ? "movie" : "tv", tmdb.Value, _aliases.Canonical(key).ToString(),
                        want.Input.Variant, want.Input.Scope, want.Input.SeasonNumbers.ToArray(), want.Input.Episodes.ToArray()));
                }
                var after = _ledger.Revision;
                return new(true, complete && before == after, snapshot.Backend, MutationInput.Hash($"{after}|{snapshot.Backend}|{snapshot.IsolationVersion}|{_view.Revision}|{viewer.PolicyRevision}|{string.Join("|", policyRevisions)}|{JsonSerializer.Serialize(titles)}"),
                    titles.OrderBy(t => t.MediaType, StringComparer.Ordinal).ThenBy(t => t.TmdbId).ThenBy(t => t.Variant, StringComparer.Ordinal).ThenBy(t => t.Scope, StringComparer.Ordinal).ToArray());
            }
            catch (Exception) { return Unknown("projection_unavailable"); }
        }
    }
}
