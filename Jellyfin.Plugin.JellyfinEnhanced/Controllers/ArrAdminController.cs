using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/arr/admin/test.</summary>
    public class ArrTestRequest
    {
        /// <summary>"sonarr" or "radarr" (optional when <see cref="InstanceId"/> names a saved instance).</summary>
        [JsonPropertyName("kind")] public string? Kind { get; set; }

        /// <summary>URL to test (optional when <see cref="InstanceId"/> is given: the saved URL is used).</summary>
        [JsonPropertyName("url")] public string? Url { get; set; }

        /// <summary>A typed key, the masked saved key, or an import handle.</summary>
        [JsonPropertyName("apiKey")] public string? ApiKey { get; set; }

        /// <summary>Saved instance whose key a masked value stands for.</summary>
        [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }
    }

    /// <summary>Body of POST /JellyfinEnhanced/admin/secrets/rollback.</summary>
    public class SecretsRollbackRequest
    {
        /// <summary>Must equal <see cref="ArrAdminController.RollbackConfirmation"/>.</summary>
        [JsonPropertyName("confirm")] public string? Confirm { get; set; }
    }

    /// <summary>
    /// Admin-only routes of "Requests &amp; downloads (new)": the instance registry and connection
    /// diagnostics (behind the master switch), plus the credential rollback used before downgrading
    /// JE (always available, since the secrets store is always on). No response carries a credential.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    [PrivateResponse]
    public class ArrAdminController : ControllerBase
    {
        /// <summary>The phrase the rollback body must carry.</summary>
        public const string RollbackConfirmation = "write-credentials-to-plugin-config";

        private readonly ArrClientFactory _clients;
        private readonly ArrAuditLog _audit;
        private readonly Services.Acquire.Requests.RequestLedger? _ledger;
        private readonly Services.Acquire.Requests.RequestHubProjection? _projection;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        public ArrAdminController(ArrClientFactory clients, ArrAuditLog audit, IUserManager userManager, Logger logger, Services.Acquire.Requests.RequestLedger? ledger = null, Services.Acquire.Requests.RequestHubProjection? projection = null)
        {
            _clients = clients;
            _audit = audit;
            _ledger = ledger;
            _projection = projection;
            _userManager = userManager;
            _logger = logger;
        }

        /// <summary>Every registered Sonarr/Radarr instance (registry v2), keys reported only as set/hint.</summary>
        [HttpGet("arr/admin/instances")]
        [Authorize]
        public IActionResult GetInstances()
        {
            if (!IsAdmin()) return Forbid();
            if (!FeatureOn()) return NotFound(new { error = "disabled" });
            var registry = _clients.Registry;
            return Ok(new
            {
                instances = registry.All().Select(c => new
                {
                    id = c.Id,
                    kind = c.Kind,
                    name = c.Name,
                    url = c.Url,
                    enabled = c.Enabled,
                    retired = c.Retired,
                    role = c.Role,
                    isDefault = c.IsDefault,
                    linkedLibraryIds = c.LinkedLibraryIds,
                    pathMappings = c.PathMappings.Select(m => new { arrPath = m.ArrPath, jellyfinPath = m.JellyfinPath }),
                    defaults = c.Defaults,
                    seerrServerId = c.SeerrServerId,
                    liveUpdates = c.LiveUpdates,
                    webhook = c.Webhook,
                    key = new { set = !string.IsNullOrEmpty(registry.ResolveApiKey(c)), hint = registry.KeyHint(c) },
                }),
                defaults = new
                {
                    radarr = registry.DefaultFor(ArrKind.Radarr, Model.Arr.ArrInstanceRole.Standard)?.Id,
                    radarr4k = registry.DefaultFor(ArrKind.Radarr, Model.Arr.ArrInstanceRole.FourK)?.Id,
                    sonarr = registry.DefaultFor(ArrKind.Sonarr, Model.Arr.ArrInstanceRole.Standard)?.Id,
                    sonarrAnime = registry.DefaultFor(ArrKind.Sonarr, Model.Arr.ArrInstanceRole.Anime)?.Id,
                },
            });
        }

        /// <summary>Tests a saved instance: status, app check, version gates, health.</summary>
        [HttpPost("arr/admin/instances/{id}/test")]
        [Authorize]
        public async Task<IActionResult> TestInstance([FromRoute] string id, CancellationToken cancellationToken)
        {
            if (!IsAdmin()) return Forbid();
            if (!FeatureOn()) return NotFound(new { error = "disabled" });
            var client = _clients.For(id, allowUnusable: true);
            if (!client.Ok)
            {
                return _clients.Registry.Get(id) == null
                    ? NotFound(new { error = "unknown_instance" })
                    : Ok(new ArrDiagnosticsResult { Ok = false, InstanceId = id, Error = new ArrDiagnosticsError { Kind = client.Error!.Kind, Message = client.Error.Message } });
            }
            return Ok(await ArrDiagnostics.TestAsync(client.Value!, cancellationToken).ConfigureAwait(false));
        }

        /// <summary>
        /// Tests values that may not be saved yet. A masked key means the saved key of
        /// <see cref="ArrTestRequest.InstanceId"/>; an import handle resolves server-side.
        /// </summary>
        [HttpPost("arr/admin/test")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> TestValues([FromBody] ArrTestRequest request, CancellationToken cancellationToken)
        {
            if (!IsAdmin()) return Forbid();
            if (!FeatureOn()) return NotFound(new { error = "disabled" });
            if (request == null) return BadRequest(new { error = "missing_body" });

            var saved = _clients.Registry.Get(request.InstanceId);
            ArrKind kind;
            if (string.Equals(request.Kind, "sonarr", StringComparison.OrdinalIgnoreCase)) kind = ArrKind.Sonarr;
            else if (string.Equals(request.Kind, "radarr", StringComparison.OrdinalIgnoreCase)) kind = ArrKind.Radarr;
            else if (saved != null) kind = saved.Kind;
            else return BadRequest(new { error = "invalid_kind" });

            var url = string.IsNullOrWhiteSpace(request.Url) ? saved?.Url : request.Url.Trim();
            if (string.IsNullOrWhiteSpace(url) || url.Length > 2048 || !ArrUrlGuard.PassesStaticChecks(url))
                return BadRequest(new { error = "invalid_url" });

            var store = JellyfinEnhanced.Instance?.Secrets;
            var storeName = saved != null ? SecretsStore.ArrKeyName(saved.Id) : null;
            // A saved (masked) key is only released for its own server.
            var savedUrls = saved != null ? new[] { saved.Url } : null;
            var key = store?.ResolveSubmitted(request.ApiKey, storeName, url, savedUrls) ?? string.Empty;
            if (string.IsNullOrEmpty(key) && saved != null && string.IsNullOrWhiteSpace(request.ApiKey) && SecretsStore.SameServer(saved.Url, url))
            {
                key = _clients.Registry.ResolveApiKey(saved);
            }
            if (string.IsNullOrEmpty(key))
            {
                return BadRequest(SecretValue.IsPlaceholder(SecretValue.FromWire(request.ApiKey))
                    ? new { error = "key_not_for_this_url" }
                    : new { error = "missing_api_key" });
            }

            var client = _clients.ForUnsaved(kind, url, key);
            var result = await ArrDiagnostics.TestAsync(client, cancellationToken).ConfigureAwait(false);
            return Ok(result);
        }

        /// <summary>
        /// The newest audited arr actions (admin view), as stored, plus <c>names</c>: the display names of the people
        /// (Jellyfin user names), titles (as the caller's own request cards name them) and instances the rows refer to
        /// by id. Ids nobody can name any more (a deleted account, a removed instance) are left out of it.
        /// </summary>
        [HttpGet("arr/admin/audit")]
        [Authorize]
        public async Task<IActionResult> GetAudit([FromQuery] int take = 50, CancellationToken cancellationToken = default)
        {
            if (!IsAdmin()) return Forbid();
            if (!FeatureOn()) return NotFound(new { error = "disabled" });
            var count = Math.Clamp(take, 1, 500);
            var choices = _ledger?.Database.Available == true ? _ledger.Choices.Audit(count) : Array.Empty<ArrAuditEntry>();
            var entries = _audit.ReadRecent(count).Concat(choices).OrderByDescending(x => x.Time).Take(count).ToArray();
            // The key each row names its title by, and that title's canonical key (what the names are resolved for).
            var keys = entries.Select(AuditTitleKey).Where(k => k.HasValue).Select(k => k!.Value).Distinct().ToArray();
            var meta = _projection == null || keys.Length == 0 || ArrCaller.PersonId(User) is not { } caller
                ? new Dictionary<string, Services.Acquire.Requests.HubTitleMeta>(StringComparer.Ordinal)
                : await _projection.AuditTitlesAsync(keys.Select(k => k.Title).Distinct(StringComparer.Ordinal), caller, cancellationToken).ConfigureAwait(false);
            var titles = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var (raw, title) in keys)
            {
                if (meta.TryGetValue(title, out var m) && !string.IsNullOrEmpty(m.Title)) titles[raw] = new { title = m.Title, year = m.Year };
            }
            return Ok(new
            {
                entries,
                names = new
                {
                    users = AuditUserNames(entries),
                    titles,
                    instances = entries.Select(e => e.InstanceId).Where(id => !string.IsNullOrEmpty(id)).Distinct(StringComparer.Ordinal)
                        .Select(id => (id, name: _clients.Registry.Get(id)?.Name)).Where(x => !string.IsNullOrEmpty(x.name)).ToDictionary(x => x.id, x => x.name, StringComparer.Ordinal),
                },
            });
        }

        // The title an audit row acts on: the key as the row names it (a search's details "key", a "key:" target, else a
        // request's or choice's target; the Audit tab looks names up by it) and the title's canonical key. Rows that
        // already carry their title (the action runner's details) need no lookup.
        internal static (string Raw, string Title)? AuditTitleKey(ArrAuditEntry entry)
        {
            if (entry.Details?.TryGetValue("title", out var named) == true && !string.IsNullOrEmpty(named)) return null;
            var raw = entry.Details?.TryGetValue("key", out var key) == true ? key : entry.Target.StartsWith("key:", StringComparison.Ordinal) ? entry.Target[4..] : entry.Target;
            return Services.Acquire.TitleKey.Parse(raw)?.Title.ToString() is { } title ? (raw, title) : null;
        }

        // Jellyfin user names of the accounts audit rows name by id: who acted, and the account a user-settings change was for.
        private Dictionary<string, string> AuditUserNames(IEnumerable<ArrAuditEntry> entries)
        {
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var id in entries.SelectMany(e => e.Action.StartsWith("users.", StringComparison.Ordinal) ? new[] { e.UserId, e.Target } : new[] { e.UserId }).Distinct(StringComparer.Ordinal))
            {
                if (!Guid.TryParseExact(id, "N", out var user)) continue;
                if (ArrCaller.Find(user, _userManager)?.Username is { Length: > 0 } name) names[id] = name;
            }
            return names;
        }

        /// <summary>
        /// Writes every stored credential back into the plugin configuration in plain text, for
        /// downgrading to a JE version without the secrets store. Run it right before installing the
        /// older version: if this version starts again it moves them back out (the sidecar keeps its copy).
        /// </summary>
        [HttpPost("admin/secrets/rollback")]
        [Authorize]
        [BodyLimit]
        public IActionResult RollbackSecrets([FromBody] SecretsRollbackRequest request)
        {
            if (!IsAdmin()) return Forbid();
            if (request?.Confirm != RollbackConfirmation)
                return BadRequest(new { error = "confirmation_required", confirm = RollbackConfirmation });
            var plugin = JellyfinEnhanced.Instance;
            if (plugin == null) return StatusCode(503);
            int restored;
            try
            {
                restored = plugin.RollbackSecretsToConfiguration();
            }
            catch (SecretsStoreUnavailableException ex)
            {
                _logger.Error("Secrets: rollback refused: " + ex.Message);
                return Conflict(new { error = "store_unavailable", message = ex.Message });
            }
            _logger.Warning($"Secrets: an administrator wrote {restored} stored credential(s) back into the plugin configuration (rollback for downgrade).");
            return Ok(new { restored });
        }

        private static bool FeatureOn() => JellyfinEnhanced.Instance?.Configuration?.ArrIntegrationEnabled == true;

        // A person with Jellyfin's administrator permission (never an API key or an unknown user).
        private bool IsAdmin() => ArrCaller.IsAdmin(User, _userManager);
    }
}
