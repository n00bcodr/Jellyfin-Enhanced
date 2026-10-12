using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/arr/admin/queue/confirm.</summary>
    public class QueueConfirmRequest
    {
        /// <summary>Instance id.</summary>
        [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

        /// <summary>The download.</summary>
        [JsonPropertyName("downloadId")] public string? DownloadId { get; set; }
    }

    /// <summary>Body of POST /JellyfinEnhanced/arr/admin/queue/action.</summary>
    public class QueueActionRequest
    {
        /// <summary>Instance id.</summary>
        [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

        /// <summary>The download.</summary>
        [JsonPropertyName("downloadId")] public string? DownloadId { get; set; }

        /// <summary>remove, remove_with_data, retry_import or search.</summary>
        [JsonPropertyName("action")] public string? Action { get; set; }

        /// <summary>Remove: also blocklist the release.</summary>
        [JsonPropertyName("blocklist")] public bool Blocklist { get; set; }

        /// <summary>Remove: search for another copy afterwards.</summary>
        [JsonPropertyName("searchAgain")] public bool SearchAgain { get; set; }

        /// <summary>One key per click.</summary>
        [JsonPropertyName("idempotencyKey")] public string? IdempotencyKey { get; set; }

        /// <summary>The confirmation token (remove with data).</summary>
        [JsonPropertyName("confirmationToken")] public string? ConfirmationToken { get; set; }
    }

    /// <summary>Body of POST /JellyfinEnhanced/arr/admin/bridge/scan.</summary>
    public class BridgeScanRequest
    {
        /// <summary>The instance that imported the path.</summary>
        [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

        /// <summary>The imported file or folder, as the arr sees it.</summary>
        [JsonPropertyName("path")] public string? Path { get; set; }

        /// <summary>One key per click.</summary>
        [JsonPropertyName("idempotencyKey")] public string? IdempotencyKey { get; set; }
    }

    /// <summary>
    /// Phase 2 of "Requests &amp; downloads": the administrator's Overview, Activity and System tabs
    /// of the Requests page, queue actions (remove keeping the data, optionally blocklisting and
    /// searching again; search again; retry the import through the arr's own command; remove with the
    /// download's data only with a fresh server-issued confirmation token) and Scan now for an
    /// imported path. Jellyfin administrators only: everyone else gets 403 before anything is read.
    /// Every action is audited through the action runner (refusals included) and mirrored into
    /// Jellyfin's activity log; so are non-administrators' calls to the action routes ("denied"). The audit itself is read through <c>GET arr/admin/audit</c>.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    [PrivateResponse]
    public class ArrAdminHubController : ControllerBase
    {
        private static readonly JsonSerializerOptions CamelCase = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Converters = { new JsonStringEnumConverter() },
        };

        private static readonly HashSet<string> Actions = new(StringComparer.Ordinal)
        {
            QueueAction.Remove, QueueAction.RemoveWithData, QueueAction.RetryImport, QueueAction.Search,
        };

        private readonly ArrAdminHubService _hub;
        private readonly ArrQueueActionService _queue;
        private readonly JellyfinBridge _bridge;
        private readonly ArrActionRunner _runner;
        private readonly ArrStatusService _status;
        private readonly ArrManageService _manage;
        private readonly IUserManager? _userManager;

        /// <summary>Creates the controller.</summary>
        public ArrAdminHubController(ArrAdminHubService hub, ArrQueueActionService queue, JellyfinBridge bridge, ArrActionRunner runner, ArrStatusService status, ArrManageService manage, IUserManager userManager)
            : this(hub, queue, bridge, runner, status, manage)
        {
            _userManager = userManager;
        }

        /// <summary>Creates the controller without a user manager (tests; audit lines then carry no user name).</summary>
        internal ArrAdminHubController(ArrAdminHubService hub, ArrQueueActionService queue, JellyfinBridge bridge, ArrActionRunner runner, ArrStatusService status, ArrManageService manage)
        {
            _manage = manage;
            _hub = hub;
            _queue = queue;
            _bridge = bridge;
            _runner = runner;
            _status = status;
        }

        /// <summary>Overview: instance cards, Needs attention, next 24 hours, two weeks of grabs and imports.</summary>
        [HttpGet("arr/admin/hub/overview")]
        [Authorize]
        public async Task<IActionResult> GetOverview(CancellationToken cancellationToken)
        {
            if (Admin() is null) return Forbid();
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            using var scope = _hub.Store.BeginRequest("arr/admin/hub/overview");
            return Json(await _hub.OverviewAsync(cancellationToken).ConfigureAwait(false));
        }

        /// <summary>Activity: downloads grouped per download with their actions, recent history.</summary>
        [HttpGet("arr/admin/hub/activity")]
        [Authorize]
        public async Task<IActionResult> GetActivity(CancellationToken cancellationToken)
        {
            if (Admin() is null) return Forbid();
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            using var scope = _hub.Store.BeginRequest("arr/admin/hub/activity");
            return Json(await _hub.ActivityAsync(cancellationToken).ConfigureAwait(false));
        }

        /// <summary>System: health, disks, tasks, versions, live connection and webhook, Seerr, Jellyfin bridge and path doctor.</summary>
        [HttpGet("arr/admin/hub/system")]
        [Authorize]
        public async Task<IActionResult> GetSystem(CancellationToken cancellationToken)
        {
            if (Admin() is null) return Forbid();
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            using var scope = _hub.Store.BeginRequest("arr/admin/hub/system");
            return Json(await _hub.SystemAsync(cancellationToken).ConfigureAwait(false));
        }

        /// <summary>
        /// Step one of "remove with data": what the download covers and a one-time token (two minutes,
        /// bound to this administrator, the instance and the download) that the action needs.
        /// </summary>
        [HttpPost("arr/admin/queue/confirm")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> Confirm([FromBody] QueueConfirmRequest? request, CancellationToken cancellationToken)
        {
            if (Admin() is not { } viewer) return Denied("arr/admin/queue/confirm");
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (request == null || !ValidId(request.InstanceId) || !ValidDownload(request.DownloadId)) return BadRequest(new { code = "invalid_request" });
            var confirmation = await _queue.ConfirmAsync(viewer, request.InstanceId!, request.DownloadId!, cancellationToken).ConfigureAwait(false);
            if (confirmation == null) return NotFound(new { code = "not_in_queue" });
            return Json(confirmation);
        }

        /// <summary>Runs a queue action (audited; one idempotency key per click; remove with data needs its token).</summary>
        [HttpPost("arr/admin/queue/action")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> QueueActionRun([FromBody] QueueActionRequest? request, CancellationToken cancellationToken)
        {
            if (Admin() is not { } viewer) return Denied("arr/admin/queue/action");
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (request == null || !ValidId(request.InstanceId) || !ValidDownload(request.DownloadId) || request.Action == null || !Actions.Contains(request.Action))
                return BadRequest(new { code = "invalid_request" });
            if (string.IsNullOrWhiteSpace(request.IdempotencyKey) || request.IdempotencyKey.Length > 64)
                return BadRequest(new { code = "idempotency_key_required" });
            if (request.ConfirmationToken is { Length: > 128 }) return BadRequest(new { code = "invalid_request" });
            var outcome = await _queue.RunAsync(viewer, UserName(viewer), new QueueActionInput
            {
                InstanceId = request.InstanceId!,
                DownloadId = request.DownloadId!,
                Action = request.Action,
                Blocklist = request.Blocklist,
                SearchAgain = request.SearchAgain,
                IdempotencyKey = request.IdempotencyKey,
                ConfirmationToken = request.ConfirmationToken,
            }, cancellationToken).ConfigureAwait(false);
            return Outcome(outcome);
        }

        /// <summary>
        /// Search now for a title (movie, series, season or episode key) on one instance, for Needs
        /// attention rows that aren't in the queue any more (a failed download the arr couldn't
        /// replace). The same audited search as the Manage drawer's.
        /// </summary>
        [HttpPost("arr/admin/hub/search")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> Search([FromBody] ManageSearchRequest? request, CancellationToken cancellationToken)
        {
            if (Admin() is not { } viewer) return Denied("arr/admin/hub/search");
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (request == null || !ValidId(request.InstanceId) || TitleKey.Parse(request.Key) is not { } key) return BadRequest(new { code = "invalid_request" });
            if (string.IsNullOrWhiteSpace(request.IdempotencyKey) || request.IdempotencyKey.Length > 64)
                return BadRequest(new { code = "idempotency_key_required" });
            return Outcome(await _manage.SearchAsync(viewer, UserName(viewer), request.InstanceId!, key, request.IdempotencyKey, cancellationToken).ConfigureAwait(false));
        }

        /// <summary>
        /// Scan now for one imported path (the arr's view): refreshes the nearest folder Jellyfin has
        /// (or queues Jellyfin's scan of that one library when the path needs a TV library's root).
        /// Paths outside every Jellyfin library are refused. Audited.
        /// </summary>
        [HttpPost("arr/admin/bridge/scan")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> Scan([FromBody] BridgeScanRequest? request, CancellationToken cancellationToken)
        {
            if (Admin() is not { } viewer) return Denied("arr/admin/bridge/scan");
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (request == null || !ValidId(request.InstanceId) || ScanPath(request.Path) is not { } path)
                return BadRequest(new { code = "invalid_request" });
            if (string.IsNullOrWhiteSpace(request.IdempotencyKey) || request.IdempotencyKey.Length > 64)
                return BadRequest(new { code = "idempotency_key_required" });
            var instance = _hub.Store.Registry.Get(request.InstanceId);
            if (instance == null || !instance.Usable) return NotFound(new { code = "unknown_instance" });
            BridgeScanResult? result = null;
            var outcome = await _runner.RunAsync(new ArrActionRequest
            {
                Action = "jellyfin.scan",
                InstanceId = instance.Id,
                Target = "path:" + path,
                UserId = viewer.UserId,
                UserName = UserName(viewer),
                IdempotencyKey = request.IdempotencyKey,
                Tier = ArrActionTier.Safe,
                Details = new Dictionary<string, string> { ["instance"] = instance.Name, ["title"] = path },
                Timeout = TimeSpan.FromMinutes(2),
                Execute = async ct =>
                {
                    result = await _bridge.ScanNowAsync(instance, path, ct).ConfigureAwait(false);
                    return result.Outcome == "refused"
                        ? new ArrError(ArrErrorKind.Validation, result.Reason == "outside_library" ? "No Jellyfin library contains that path (check the path mappings)." : "The library could not be found.")
                        : null;
                },
                ReadBack = _ => Task.FromResult(new ArrReadBack
                {
                    Confirmed = result?.Outcome == "library" ? null : result?.Found,
                    Summary = result?.Outcome switch
                    {
                        "present" => "Jellyfin already has it.",
                        "refreshed" => result.Found ? "Jellyfin has it now." : "Refreshed; Jellyfin doesn't list it yet.",
                        "library" => "Jellyfin is scanning the " + result.Library + " library.",
                        _ => string.Empty,
                    },
                }),
            }, cancellationToken).ConfigureAwait(false);
            return Outcome(outcome, result);
        }

        private IActionResult Outcome(ArrActionOutcome outcome, BridgeScanResult? scan = null)
            => Json(new
            {
                status = outcome.Status,
                message = outcome.Message,
                readBack = outcome.ReadBack?.Summary,
                confirmed = outcome.ReadBack?.Confirmed,
                auditId = outcome.AuditId,
                replayed = outcome.Replayed,
                error = outcome.Error == null ? null : new { kind = outcome.Error.Kind, message = outcome.Error.Message },
                scan,
            });

        private FileContentResult Json(object value)
            => File(JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), CamelCase), "application/json; charset=utf-8");

        private static bool ValidId(string? id) => !string.IsNullOrWhiteSpace(id) && id.Length <= 64;

        /// <summary>
        /// A Scan now path, normalised the way the bridge reads it (trimmed, "\" as "/"): absolute
        /// ("/…" or "C:/…"), at most 1024 characters, with no "." or ".." segment and no NUL (library
        /// containment is a plain prefix test, so a ".." would reach outside a library). Null when invalid.
        /// </summary>
        internal static string? ScanPath(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw) || raw.Length > 1024 || raw.Contains('\0', StringComparison.Ordinal)) return null;
            var path = raw.Trim().Replace('\\', '/');
            if (!path.StartsWith('/') && !(path.Length > 2 && path[1] == ':' && path[2] == '/')) return null;
            foreach (var segment in path.Split('/'))
            {
                if (segment.Trim() is "." or "..") return null;
            }
            return path;
        }

        private static bool ValidDownload(string? id) => !string.IsNullOrWhiteSpace(id) && id.Length <= 200;

        private string? UserName(StatusViewer viewer)
        {
            try
            {
                return _userManager?.GetUserById(viewer.UserId)?.Username;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// 403 for a signed-in non-administrator calling one of the action routes, with one "denied"
        /// audit row (mirrored into Jellyfin's activity log) per user and route a minute at most, so
        /// probing is visible without one line per request.
        /// </summary>
        private IActionResult Denied(string route)
        {
            if (ArrCaller.PersonId(User) is Guid id)
            {
                var now = DateTimeOffset.UtcNow;
                var key = id.ToString("N") + " " + route;
                if (DeniedSeen.Count > 1000) DeniedSeen.Clear();
                var last = DeniedSeen.GetOrAdd(key, DateTimeOffset.MinValue);
                if (now - last >= DeniedEvery && DeniedSeen.TryUpdate(key, now, last))
                {
                    string? name;
                    try
                    {
                        name = _userManager?.GetUserById(id)?.Username;
                    }
                    catch (Exception)
                    {
                        name = null;
                    }
                    _runner.Audit.Append(new ArrAuditEntry
                    {
                        Time = now,
                        UserId = id.ToString("N"),
                        UserName = name ?? "A user who isn't an administrator",
                        Action = ArrActivityMirror.DeniedAction,
                        Target = "route:" + route,
                        Outcome = "denied",
                        Error = "not_admin",
                        Message = "Only Jellyfin administrators can use " + route + ".",
                    });
                }
            }
            return Forbid();
        }

        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateTimeOffset> DeniedSeen = new(StringComparer.Ordinal);
        private static readonly TimeSpan DeniedEvery = TimeSpan.FromMinutes(1);

        /// <summary>The caller when they are a Jellyfin administrator (a person, never an API key or an unknown user), else null.</summary>
        private StatusViewer? Admin() => ArrCaller.Admin(User, _status.View);
    }
}
