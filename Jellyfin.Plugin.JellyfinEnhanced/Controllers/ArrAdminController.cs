using System;
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
        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        public ArrAdminController(ArrClientFactory clients, ArrAuditLog audit, IUserManager userManager, Logger logger, Services.Acquire.Requests.RequestLedger? ledger = null)
        {
            _clients = clients;
            _audit = audit;
            _ledger = ledger;
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

        /// <summary>The newest audited arr actions (admin view).</summary>
        [HttpGet("arr/admin/audit")]
        [Authorize]
        public IActionResult GetAudit([FromQuery] int take = 50)
        {
            if (!IsAdmin()) return Forbid();
            if (!FeatureOn()) return NotFound(new { error = "disabled" });
            var count = Math.Clamp(take, 1, 500);
            var choices = _ledger?.Database.Available == true ? _ledger.Choices.Audit(count) : Array.Empty<ArrAuditEntry>();
            return Ok(new { entries = _audit.ReadRecent(count).Concat(choices).OrderByDescending(x => x.Time).Take(count).ToArray() });
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
