using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/acquire/changes.</summary>
    public class ArrChangesRequest
    {
        /// <summary>The epoch from the previous answer (null on the first call).</summary>
        [JsonPropertyName("epoch")] public string? Epoch { get; set; }

        /// <summary>The cursor from the previous answer.</summary>
        [JsonPropertyName("cursor")] public long? Cursor { get; set; }

        /// <summary>Title keys the page shows (at most 500, more is a 400; empty means every title the user may see).</summary>
        [JsonPropertyName("keys")] public List<string>? Keys { get; set; }

        /// <summary>Seconds to wait for a change (0-25, default 25).</summary>
        [JsonPropertyName("wait")] public int? Wait { get; set; }
    }

    /// <summary>Body of the webhook set-up/removal routes.</summary>
    public class ArrWebhookRequest
    {
        /// <summary>Must be true: the administrator agreed to let JE change the arr's settings.</summary>
        [JsonPropertyName("consent")] public bool Consent { get; set; }

        /// <summary>Jellyfin's address as the arr sees it (defaults to the saved setting).</summary>
        [JsonPropertyName("jellyfinUrl")] public string? JellyfinUrl { get; set; }

        /// <summary>One key per click (a repeated click gets the first outcome).</summary>
        [JsonPropertyName("idempotencyKey")] public string? IdempotencyKey { get; set; }
    }

    /// <summary>
    /// Live updates for "Requests &amp; downloads (new)", phase 1:
    /// <list type="bullet">
    /// <item><description><c>POST arr/hook/{instanceId}</c>: the arrs' webhook receiver. Anonymous,
    /// checked by the instance's shared secret; only ever triggers re-reads.</description></item>
    /// <item><description><c>POST acquire/changes</c>: the change feed browsers long-poll (any signed-in
    /// user; filtered per user before anything leaves the server).</description></item>
    /// <item><description><c>arr/admin/live</c> and <c>arr/admin/instances/{id}/webhook*</c>: the
    /// admin's live-updates status and webhook set-up (consent, copy-paste alternative, removal).</description></item>
    /// </list>
    /// No response carries an arr URL, API key or path to a non-admin; the webhook secret is only
    /// returned by the explicit (audited) copy-paste route.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class ArrLiveController : ControllerBase
    {
        /// <summary>Longest a long-poll is held.</summary>
        public const int MaxWaitSeconds = 25;

        private static readonly ArrSnapshotKind[] WatchedKinds = { ArrSnapshotKind.Queue, ArrSnapshotKind.History, ArrSnapshotKind.Library };

        private readonly ArrChangeFeed _feed;
        private readonly ArrFeedLimits _limits;
        private readonly IArrFeedAudience _audience;
        private readonly ArrWebhookReceiver _receiver;
        private readonly ArrWebhookProvisioner _provisioner;
        private readonly ArrLiveService _live;
        private readonly ArrLiveRouter _router;
        private readonly ArrStateStore _store;
        private readonly ArrAuditLog _audit;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;
        private readonly SeerrRequestReadModel _requests;

        /// <summary>Creates the controller.</summary>
        public ArrLiveController(
            ArrChangeFeed feed,
            ArrFeedLimits limits,
            IArrFeedAudience audience,
            ArrWebhookReceiver receiver,
            ArrWebhookProvisioner provisioner,
            ArrLiveService live,
            ArrLiveRouter router,
            ArrStateStore store,
            ArrAuditLog audit,
            IUserManager userManager,
            Logger logger,
            SeerrRequestReadModel requests)
        {
            _feed = feed;
            _limits = limits;
            _audience = audience;
            _receiver = receiver;
            _provisioner = provisioner;
            _live = live;
            _router = router;
            _store = store;
            _audit = audit;
            _userManager = userManager;
            _logger = logger;
            _requests = requests;
        }

        /// <summary>Phase 1 on (and the master switch). Tests replace the configuration source.</summary>
        internal Func<PluginConfiguration?> Config { get; set; } = () => JellyfinEnhanced.Instance?.Configuration;

        /// <summary>
        /// Receives a Sonarr/Radarr webhook for one instance. The secret header must match; the body
        /// (≤ 1 MiB) only says what to re-read. Answers 204 with no body, or 401/413/429/400.
        /// </summary>
        [HttpPost("arr/hook/{instanceId}")]
        [AllowAnonymous]
        [RequestSizeLimit(ArrWebhookReceiver.MaxBodyBytes + 4096)]
        public async Task<IActionResult> ReceiveWebhook([FromRoute] string instanceId, CancellationToken cancellationToken)
        {
            if (!ArrLiveFlags.Enabled(Config())) return NotFound();
            if (Request.ContentLength is long declared && declared > ArrWebhookReceiver.MaxBodyBytes) return StatusCode(StatusCodes.Status413PayloadTooLarge);
            byte[] body;
            try
            {
                body = await ReadCappedAsync(Request.Body, ArrWebhookReceiver.MaxBodyBytes, cancellationToken).ConfigureAwait(false);
            }
            catch (InvalidDataException)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge);
            }
            var secret = Request.Headers[ArrWebhookReceiver.SecretHeader].FirstOrDefault();
            var source = HttpContext.Connection.RemoteIpAddress?.ToString();
            switch (_receiver.Receive(instanceId, secret, body, source))
            {
                case ArrWebhookOutcome.Accepted:
                    return NoContent();
                case ArrWebhookOutcome.RateLimited:
                    Response.Headers.RetryAfter = "10";
                    return StatusCode(StatusCodes.Status429TooManyRequests);
                case ArrWebhookOutcome.Invalid:
                    return BadRequest();
                default:
                    return Unauthorized();
            }
        }

        /// <summary>
        /// The change feed. Answers at once with the current cursor on the first call (no epoch),
        /// with the changed keys the caller asked about and may see as soon as there are any, or
        /// with none after <c>wait</c> seconds. <c>reset: true</c> means the cursor can't be served
        /// (restart, too old): re-read everything shown.
        /// </summary>
        [HttpPost("acquire/changes")]
        [Authorize]
        [RequestSizeLimit(256 * 1024)]
        public async Task<IActionResult> GetChanges([FromBody] ArrChangesRequest? request, CancellationToken cancellationToken)
        {
            if (!ArrLiveFlags.Enabled(Config()))
                return StatusCode(403, new { error = true, code = "feature_disabled", message = "Requests & downloads (phase 1) is turned off in the Jellyfin Enhanced settings." });
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId is not Guid uid) return Unauthorized();
            Response.Headers.CacheControl = "no-store";
            request ??= new ArrChangesRequest();
            // Never answer for part of the list (changes to the dropped keys would be skipped for
            // good): a page showing more titles than that sends no keys (every title it may see).
            if (request.Keys is { Count: > ArrChangeFeed.MaxKeysPerRead })
                return BadRequest(new { error = true, code = "too_many_keys", message = $"At most {ArrChangeFeed.MaxKeysPerRead} keys; send none to hear about every title." });

            if (string.IsNullOrEmpty(request.Epoch) || request.Cursor is null)
            {
                return Ok(new { epoch = _feed.Epoch, cursor = _feed.Cursor, keys = Array.Empty<string>(), reset = false });
            }

            HashSet<string>? wanted = null;
            if (request.Keys is { Count: > 0 })
            {
                wanted = new HashSet<string>(request.Keys.Where(ArrTitleKey.IsFeedKey), StringComparer.Ordinal);
                // Only the Requests page follows the shared request-list state key (the Seerr
                // more-info modal may follow the caller's own request list too): while it is open
                // (it long-polls continuously), Seerr is re-read every 30 s.
                if (wanted.Contains(ArrTitleKey.RequestsState)) _requests.Touch();
            }
            var wait = TimeSpan.FromSeconds(Math.Clamp(request.Wait ?? MaxWaitSeconds, 0, MaxWaitSeconds));

            if (!_limits.TryEnter(uid))
            {
                Response.Headers.RetryAfter = "10";
                return StatusCode(StatusCodes.Status429TooManyRequests, new { error = true, code = "too_many_waits" });
            }
            // Counted like the other snapshot-served routes: the feed never calls an arr.
            using var scope = _store.BeginRequest("acquire/changes");
            try
            {
                // Someone is watching: keep the snapshots behind status current (polling fallback).
                _store.KeepWarm(WatchedKinds);
                var isAdmin = IsAdmin();
                var deadline = DateTimeOffset.UtcNow + wait;
                var after = request.Cursor.Value;
                while (true)
                {
                    var read = _feed.Read(request.Epoch, after);
                    if (read.Reset) return Ok(new { epoch = _feed.Epoch, cursor = read.Cursor, keys = Array.Empty<string>(), reset = true });
                    IReadOnlyList<ArrFeedChange> asked = wanted == null ? read.Changes : read.Changes.Where(c => wanted.Contains(c.Key)).ToList();
                    if (asked.Count > ArrChangeFeed.MaxKeysPerRead)
                        return Ok(new { epoch = _feed.Epoch, cursor = read.Cursor, keys = Array.Empty<string>(), reset = true });
                    IReadOnlyCollection<string> visible = asked.Count == 0 ? Array.Empty<string>() : _audience.Visible(uid, isAdmin, asked);
                    var remaining = deadline - DateTimeOffset.UtcNow;
                    if (visible.Count > 0 || remaining <= TimeSpan.Zero)
                        return Ok(new { epoch = _feed.Epoch, cursor = read.Cursor, keys = visible, reset = false });
                    // Nothing for this caller: skip past those changes and keep waiting.
                    after = read.Cursor;
                    await _feed.WaitAsync(after, remaining, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return new EmptyResult();
            }
            finally
            {
                _limits.Exit(uid);
            }
        }

        /// <summary>Live-updates status per instance (admin): SignalR connection, webhook traffic, feed.</summary>
        [HttpGet("arr/admin/live")]
        [Authorize]
        public IActionResult GetLiveStatus()
        {
            if (!IsAdmin()) return Forbid();
            var config = Config();
            if (config?.ArrIntegrationEnabled != true) return NotFound(new { error = "disabled" });
            var now = DateTimeOffset.UtcNow;
            return Ok(new
            {
                enabled = ArrLiveFlags.Enabled(config),
                jellyfinUrl = config.ArrWebhookJellyfinUrl ?? string.Empty,
                feed = new { epoch = _feed.Epoch, cursor = _feed.Cursor, totalChanges = _feed.TotalBumps, waiting = _limits.Waiting },
                instances = _store.Registry.All().Select(c =>
                {
                    var stats = _receiver.Stats(c.Id);
                    var secretSet = _receiver.HasSecret(c.Id);
                    var router = _router.Stats(c.Id);
                    return new
                    {
                        id = c.Id,
                        name = c.Name,
                        kind = c.Kind,
                        usable = c.Usable,
                        liveUpdates = c.LiveUpdates,
                        signalR = _live.ConnectionStatus(c.Id),
                        webhook = new
                        {
                            secretSet,
                            accepted = stats.Accepted,
                            refused = stats.Refused,
                            lastEventAt = stats.LastEventAt,
                            lastEventType = stats.LastEventType,
                            lastTestAt = stats.LastTestAt,
                            silent = secretSet && WebhookSilent(c.Id, stats, now),
                        },
                        hints = router.Hints,
                        rereads = router.Flushes,
                        searches = _live.ActiveSearches(c.Id).Count,
                    };
                }).ToList(),
            });
        }

        /// <summary>What the arr's Connect list holds for JE's webhook of this instance (reads the arr; never the secret).</summary>
        [HttpGet("arr/admin/instances/{id}/webhook")]
        [Authorize]
        public async Task<IActionResult> GetWebhook([FromRoute] string id, CancellationToken cancellationToken)
        {
            if (!IsAdmin()) return Forbid();
            if (Config()?.ArrIntegrationEnabled != true) return NotFound(new { error = "disabled" });
            var instance = _store.Registry.Get(id);
            if (instance == null) return NotFound(new { error = "unknown_instance" });
            return Ok(await _provisioner.GetStateAsync(instance, Config()?.ArrWebhookJellyfinUrl, cancellationToken).ConfigureAwait(false));
        }

        /// <summary>
        /// Sets up (or repairs) JE's webhook in the arr. Needs <c>consent: true</c> and Jellyfin's
        /// address as the arr sees it. Audited; idempotent.
        /// </summary>
        [HttpPost("arr/admin/instances/{id}/webhook")]
        [Authorize]
        public async Task<IActionResult> ProvisionWebhook([FromRoute] string id, [FromBody] ArrWebhookRequest? request, CancellationToken cancellationToken)
        {
            if (!IsAdmin()) return Forbid();
            if (!ArrLiveFlags.Enabled(Config())) return NotFound(new { error = "disabled" });
            var instance = _store.Registry.Get(id);
            if (instance == null) return NotFound(new { error = "unknown_instance" });
            if (request?.Consent != true) return BadRequest(new { error = "consent_required" });
            if (!ArrWebhookProvisioner.TryNormalizeJellyfinUrl(request.JellyfinUrl ?? Config()?.ArrWebhookJellyfinUrl, out var jellyfinUrl))
                return BadRequest(new { error = "invalid_jellyfin_url" });
            var outcome = await RunGuarded(() => _provisioner.ProvisionAsync(instance, jellyfinUrl, CurrentUserId(), UserName(), IdempotencyKey(request), cancellationToken)).ConfigureAwait(false);
            return outcome ?? StatusCode(409, new { error = "secrets_unavailable" });
        }

        /// <summary>Removes JE's webhook(s) from the arr and forgets the secret. Needs <c>consent: true</c>. Audited.</summary>
        [HttpDelete("arr/admin/instances/{id}/webhook")]
        [Authorize]
        public async Task<IActionResult> RemoveWebhook([FromRoute] string id, [FromBody] ArrWebhookRequest? request, CancellationToken cancellationToken)
        {
            if (!IsAdmin()) return Forbid();
            if (Config()?.ArrIntegrationEnabled != true) return NotFound(new { error = "disabled" });
            var instance = _store.Registry.Get(id);
            if (instance == null) return NotFound(new { error = "unknown_instance" });
            if (request?.Consent != true) return BadRequest(new { error = "consent_required" });
            var outcome = await RunGuarded(() => _provisioner.RemoveAsync(instance, CurrentUserId(), UserName(), IdempotencyKey(request), cancellationToken)).ConfigureAwait(false);
            return outcome ?? StatusCode(409, new { error = "secrets_unavailable" });
        }

        /// <summary>
        /// Copy-paste set-up for doing it by hand in the arr: URL, header name and the secret
        /// (created if there is none). The only response that carries the secret: admin only, audited.
        /// </summary>
        [HttpPost("arr/admin/instances/{id}/webhook/manual")]
        [Authorize]
        public IActionResult ManualWebhook([FromRoute] string id, [FromBody] ArrWebhookRequest? request)
        {
            if (!IsAdmin()) return Forbid();
            if (!ArrLiveFlags.Enabled(Config())) return NotFound(new { error = "disabled" });
            var instance = _store.Registry.Get(id);
            if (instance == null) return NotFound(new { error = "unknown_instance" });
            if (!ArrWebhookProvisioner.TryNormalizeJellyfinUrl(request?.JellyfinUrl ?? Config()?.ArrWebhookJellyfinUrl, out var jellyfinUrl))
                return BadRequest(new { error = "invalid_jellyfin_url" });
            ArrWebhookManualSetup setup;
            try
            {
                setup = _provisioner.ManualSetup(instance, jellyfinUrl);
            }
            catch (SecretsStoreUnavailableException ex)
            {
                _logger.Error("Arr live: the webhook secret could not be stored: " + ex.Message);
                return StatusCode(409, new { error = "secrets_unavailable" });
            }
            _audit.Append(new ArrAuditEntry
            {
                Time = DateTimeOffset.UtcNow,
                UserId = CurrentUserId().ToString("N"),
                UserName = UserName(),
                Action = "webhook.manual-setup-shown",
                Tier = (int)ArrActionTier.Safe,
                InstanceId = instance.Id,
                Target = "notification:webhook",
                Outcome = "succeeded",
            });
            Response.Headers.CacheControl = "no-store";
            return Ok(setup);
        }

        // No webhook event for a day while the arr imported something since the last one.
        private bool WebhookSilent(string instanceId, ArrWebhookStats stats, DateTimeOffset now)
        {
            var since = stats.LastEventAt ?? StartedAt;
            if (now - since < TimeSpan.FromHours(24)) return false;
            var history = _store.PeekHistory(instanceId);
            return history != null && history.Records.Any(r => r.Date is DateTime d && d > since.UtcDateTime
                && (r.EventType ?? string.Empty).EndsWith("Imported", StringComparison.OrdinalIgnoreCase));
        }

        private static readonly DateTimeOffset StartedAt = DateTimeOffset.UtcNow;

        private async Task<IActionResult?> RunGuarded(Func<Task<ArrActionOutcome>> run)
        {
            try
            {
                var outcome = await run().ConfigureAwait(false);
                return Ok(new
                {
                    status = outcome.Status,
                    message = outcome.Message,
                    readBack = outcome.ReadBack?.Summary,
                    confirmed = outcome.ReadBack?.Confirmed,
                    auditId = outcome.AuditId,
                    replayed = outcome.Replayed,
                    error = outcome.Error == null ? null : new { kind = outcome.Error.Kind, message = outcome.Error.Message },
                });
            }
            catch (SecretsStoreUnavailableException ex)
            {
                _logger.Error("Arr live: the webhook secret could not be stored: " + ex.Message);
                return null;
            }
        }

        private static string IdempotencyKey(ArrWebhookRequest request)
        {
            var key = (request.IdempotencyKey ?? string.Empty).Trim();
            return key.Length is > 0 and <= 100 ? key : Guid.NewGuid().ToString("N");
        }

        private static async Task<byte[]> ReadCappedAsync(Stream body, int cap, CancellationToken cancellationToken)
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            int n;
            while ((n = await body.ReadAsync(chunk, cancellationToken).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + n > cap) throw new InvalidDataException("too large");
                buffer.Write(chunk, 0, n);
            }
            return buffer.ToArray();
        }

        private Guid CurrentUserId() => UserHelper.GetCurrentUserId(User) ?? Guid.Empty;

        private string? UserName()
        {
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                return id.HasValue ? _userManager.GetUserById(id.Value)?.Username : null;
            }
            catch
            {
                return null;
            }
        }

        private bool IsAdmin()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue ? _userManager.GetUserById(id.Value) : null;
                return user != null && user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch
            {
                return false;
            }
        }
    }
}
