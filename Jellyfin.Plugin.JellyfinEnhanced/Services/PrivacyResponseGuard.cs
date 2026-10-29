using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The one commit point of a protected answer. A gated response's bytes are held until the answer is complete (its writer
/// finished, or it reached its declared length); then its read-sets are validated, the response is started (the host's
/// start callbacks run, and the read-sets are checked once more), and only then are the bytes
/// handed to the transport. Nothing protected leaves before that validation, so nothing ever needs retracting: an input
/// that changed before the commit makes the answer be built again (native answers, the tag cache) or withheld (an empty,
/// uncached 503). Evidence writers wait for a commit token until OnCompleted (bounded by EvidenceRevision's drain budget),
/// independently of host callback order. Validators are confirmed the same way: a 304 is decided
/// at the header commit (<see cref="Confirm"/>). Answers larger than <see cref="MaxHeld"/> are committed when they reach it
/// (their remaining bytes come from the same validated answer). Unprotected responses (no guard) stream as before.
/// </summary>
public sealed class PrivacyResponseGuard : IDisposable
{
    /// <summary>The most a protected answer holds before it is committed (larger ones commit at this point).</summary>
    public const int MaxHeld = 128 * 1024 * 1024;

    private readonly HttpContext _http;
    private readonly List<PrivacyReadSet> _reads = new();
    private readonly object _lock = new();
    private GuardedBody? _body;
    private GuardedBody? _transportBody;
    private EvidencePublication? _evidence;
    private Acquire.Backends.BackendPublicationStamp? _backendPublication;
    private string? _backendFailure;
    private int _backendFailureSent;
    private bool _titleFreeTransient;
    // An answer withheld here is shaped as the route's own "no such thing" 404 (WithholdAsAbsent): absent-title artwork,
    // whose withheld answer must not differ from a permanently missing image.
    private bool _withholdAsAbsent;
    private bool _evidenceIndependent;
    private bool _detached;
    private IDisposable? _commitToken;
    private CancellationTokenRegistration _aborted;
    private bool _finished;
    private int _stopped;
    private bool _committing;
    private bool _committed;
    private bool _startChecked;
    private bool _owned;
    private bool _resourceOwned;
    private bool _rawDownloadCandidate;

    private PrivacyResponseGuard(HttpContext http)
    {
        _http = http;
        http.Response.OnCompleted(static state => { ((PrivacyResponseGuard)state).Dispose(); return Task.CompletedTask; }, this);
        http.Response.RegisterForDispose(this);
        _aborted = http.RequestAborted.Register(static state => ((PrivacyResponseGuard)state!).Dispose(), this);
        if (_finished) _aborted.Unregister();
    }

    /// <summary>Ends the commit interval, once, on transport completion, abort, exception or request disposal.</summary>
    public void Dispose()
    {
        IDisposable? token;
        lock (_lock) { _finished = true; token = _commitToken; _commitToken = null; }
        token?.Dispose();
        _aborted.Unregister();
    }

    private bool TakeCommitToken()
    {
        lock (_lock)
        {
            if (_finished || _http.RequestAborted.IsCancellationRequested) return false;
            if (_evidence == null || _evidence.Revision == "-" || _titleFreeTransient || _commitToken != null) return Holds();
            _commitToken = EvidenceRevision.TryAcquire(() => Holds());
            return _commitToken != null;
        }
    }

    /// <summary>
    /// Guards the response of <paramref name="http"/> with <paramref name="reads"/> (an answer validated with it is in the
    /// response): its body is held until the commit, which validates every set installed on it.
    /// </summary>
    public static PrivacyResponseGuard? Install(HttpContext? http, PrivacyReadSet reads)
    {
        if (http == null) return null;
        var guard = Of(http);
        lock (guard._lock) if (!guard._reads.Contains(reads)) guard._reads.Add(reads);
        return guard;
    }

    /// <summary>Admits the effective viewer before their first evidence read, independently of verb or result schema.</summary>
    internal static void Admit(HttpContext http, SeerrParentalFilter? parental, Guid? viewer, bool grant = false)
    {
        if (parental == null || viewer == null || viewer == Guid.Empty) return;
        var guard = Find(http) ?? Of(http);
        lock (guard._lock)
        {
            // A validated grant supplies the authority even when another principal accompanies its URL.
            if (!guard._evidenceIndependent && (guard._evidence == null || grant)) guard._evidence = parental.CapturePublication(viewer);
        }
    }

    /// <summary>The service rebuilt its entire answer under this final dependency (Discover's partial-read contract).</summary>
    internal static void Publication(HttpContext http, EvidencePublication publication)
    {
        var guard = Find(http) ?? Of(http);
        lock (guard._lock) guard._evidence = publication;
    }

    /// <summary>A long-poll takes no token while idle; each message/batch starts a fresh evidence dependency.</summary>
    // Retain the consumed original backend dependencies after the action scope ends. The same
    // body/header owner checks them during serialization, OnStarting and the final byte commit.
    internal static void BackendPublication(HttpContext http, Acquire.Backends.BackendPublicationStamp publication)
    {
        if (!publication.HasDependencies) return;
        var guard = Find(http) ?? Of(http);
        lock (guard._lock) guard._backendPublication = publication;
    }

    private bool BackendHolds()
    {
        Acquire.Backends.BackendPublicationStamp? publication;
        lock (_lock) publication = _backendPublication;
        try { publication?.DemandCurrent(); return true; }
        catch (Acquire.Backends.BackendDisabledException ex)
        {
            lock (_lock) _backendFailure = ex.Reason;
            return false;
        }
    }

    internal static void BeginMessage(HttpContext http)
    {
        if (Find(http) is not { } guard) return;
        lock (guard._lock) guard._evidence = guard._evidence?.NextMessage();
    }

    /// <summary>Audited settings/authority acknowledgements contain no parental title decisions.</summary>
    internal static bool EvidenceIndependent(Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor descriptor)
    {
        if (descriptor is not ControllerActionDescriptor action || action.ControllerTypeInfo?.Assembly != typeof(PrivacyResponseGuard).Assembly) return false;
        // Explicit action contracts, never a heuristic based on a small JSON object (counts/ids can be title facts).
        return action.ControllerName switch
        {
            "ConfigurationPatch" => action.ActionName == "Patch",
            "JeBackup" => action.ActionName == "Restore",
            "AcquireMigration" => action.ActionName is "Commit" or "Rollback",
            "AcquireAdminUsers" => action.ActionName is "Policy" or "PoolMembership" or "Display" or "SeerrImport",
            "AcquireHousehold" => action.ActionName == "SaveHousehold",
            "AcquireRules" => action.ActionName == "SaveRules",
            "AcquireReady" => action.ActionName is "Put" or "Remove",
            "AcquireRequests" => action.ActionName is "Cancel" or "Decline" or "LabHold" or "LabDelete",
            "ArrAdminAutomation" => action.ActionName is "DismissNotice" or "ResetBreaker",
            "ArrAdmin" => action.ActionName is "TestInstance" or "TestValues" or "RollbackSecrets",
            "ArrState" => action.ActionName == "RequestRefresh",
            "ArrLive" => action.ActionName is "ReceiveWebhook" or "ProvisionWebhook" or "RemoveWebhook" or "ManualWebhook",
            "CatchUp" => action.ActionName == "PostEvent",
            "Notify" => action.ActionName is "MarkRead" or "PutPrefs" or "SetTopic" or "StartEmail" or "VerifyEmail" or "RemoveEmail"
                or "SendTest" or "PutFollow" or "Remind" or "AssignTopic" or "AdminTest",
            "JellyfinEnhanced" => action.ActionName is "TrackUsage" or "SaveUserSettingsDdd" or "SaveUserSettingsSettings"
                or "SetUserSettingsConsent" or "PatchUserSettingsSettings" or "PatchUserBookmark" or "PatchUserSettingsDdd"
                or "PatchUserSettingsShortcuts" or "PatchUserSettingsElsewhere" or "SaveUserSettingsShortcuts" or "SaveUserBookmark"
                or "AddUserBookmark" or "RemoveUserBookmark" or "SaveUserSettingsElsewhere" or "SaveUserHiddenContent"
                or "PutHiddenContentRule" or "DeleteHiddenContentRule" or "PatchUserHiddenContent" or "SaveUserSpoilerBlur"
                or "AdminUnhideForUser" or "AdminHideForUser" or "AckSpoilerBlurCorruption" or "StartSpoilerApplyExisting"
                or "PatchSpoilerBlurUserPrefs" or "SetSpoilerBlurUserPrefs" or "EnableSpoilerBlurForSeries" or "DisableSpoilerBlurForSeries"
                or "EnableSpoilerBlurForMovie" or "DisableSpoilerBlurForMovie" or "EnableSpoilerBlurForCollection" or "DisableSpoilerBlurForCollection"
                or "EnableSpoilerBlurPending" or "DisableSpoilerBlurPending" or "HideFromContinueWatching" or "HideFromNextUp"
                or "UnhideFromContinueWatching" or "UnhideFromNextUp" or "UpsertReview" or "AdminUpsertReview" or "DeleteReview"
                or "AdminDeleteReview" or "ResetAllUsersSettings" or "RebuildTagCache" or "DismissWhatsNew" or "UploadBrandingImage"
                or "DeleteBrandingImage" or "BroadcastMessage" or "EnableMaintenanceMode" or "DisableMaintenanceMode" or "BroadcastMaintenanceMessage",
            _ => false,
        };
    }

    internal static void AdmitAction(HttpContext http, Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor descriptor,
        SeerrParentalFilter? parental, Guid? viewer)
    {
        var guard = Find(http) ?? Of(http);
        if (EvidenceIndependent(descriptor))
        {
            lock (guard._lock) { guard._evidenceIndependent = true; guard._evidence = null; }
        }
        Admit(http, parental, viewer);
    }

    // MVC failed before handing out an answer. The host's fresh error body owns its original transport and status.
    internal void HandBackError()
    {
        Discard();
        Dispose();
        lock (_lock) _detached = true;
        if (_http.Response.HasStarted) { _http.Abort(); return; }
        if (_transportBody?.Transport is { } original) _http.Features.Set(original);
    }

    /// <summary>Admission coverage, independent of HTTP verb, JSON registration or result type.</summary>
    internal static bool Owns(Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor descriptor)
    {
        var action = descriptor as ControllerActionDescriptor;
        if (action?.ControllerTypeInfo?.Assembly == typeof(PrivacyResponseGuard).Assembly) return true;
        // The host's non-controller descriptors expose the same endpoint identity in RouteValues.
        var controller = action?.ControllerName ?? (descriptor.RouteValues.TryGetValue("controller", out var c) ? c : null);
        var name = action?.ActionName ?? (descriptor.RouteValues.TryGetValue("action", out var a) ? a : null);
#if JF12
        if (NativeDetails.NativeDetailsAllowlist.Find(controller, name) != null) return true;
#endif
        return PrivacySurfaceRegistry.Entries.Any(e => e.Controller == controller && e.Action == name);
    }

    /// <summary>Checks the same dependency before result execution and at the controlled HTTP commit.</summary>
    internal static bool BeforeResult(ResultExecutingContext context)
    {
        var http = context.HttpContext;
        if (Find(http) is not { } guard) return true;
        if (!guard.BackendHolds())
        {
            guard.Stop();
            context.Result = new StatusCodeResult(409);
            return false;
        }
        if (!HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method)
            && context.Result is StatusCodeResult { StatusCode: >= 200 and < 300 })
        {
            lock (guard._lock) { guard._evidenceIndependent = true; guard._evidence = null; }
        }
        // The import service has already discarded every candidate. Regenerate the fixed, title-free retry contract;
        // never bless an arbitrary caller-supplied error message or a metadata-bearing result as evidence independent.
        if (context.Result is ObjectResult { Value: Model.ListPlaceholders.ListErrorDto error } transient
            && (transient.StatusCode == 504 && error.Code == "parental_pending" || transient.StatusCode == 429))
        {
            context.Result = new ObjectResult(new Model.ListPlaceholders.ListErrorDto
            {
                Code = transient.StatusCode == 504 ? "parental_pending" : error.Code,
                Message = transient.StatusCode == 504 ? "Checking titles against your parental controls; try again in a moment." : "Too many lookups; try again shortly.",
            }) { StatusCode = transient.StatusCode };
            lock (guard._lock) { guard._evidence = null; guard._titleFreeTransient = true; }
            http.Response.Headers.CacheControl = "private, no-store";
            if (transient.StatusCode == 504 || !http.Response.Headers.ContainsKey("Retry-After")) http.Response.Headers["Retry-After"] = "2";
            http.Response.Headers.Remove("ETag");
            http.Response.Headers.Remove("Last-Modified");
            return false;
        }
        // Privacy projections re-read and replace their own dependencies at the final result gate. An earlier
        // projection's obsolete read-set must not prevent that rebuild; every retained set is still checked at commit.
        // Parental evidence belongs to the action's answer and cannot be refreshed by a privacy-only projection.
        lock (guard._lock) if (!guard.Stopped && guard._evidence is not { Current: false }) return true;
        guard.Stop();
        bool absent;
        lock (guard._lock) absent = guard._withholdAsAbsent;
        context.Result = absent && guard._backendFailure == null ? new NotFoundResult() : new StatusCodeResult(503);
        return false;
    }

    /// <summary>
    /// The host's object answer, executed through the guard: the host's executor writes it into the held body, then it is
    /// committed; when an input changed before the commit it is projected again (<paramref name="rebuild"/>, bounded) and
    /// written again, else withheld.
    /// </summary>
    /// <param name="answer">The answer.</param>
    /// <param name="guard">The response's guard.</param>
    /// <param name="rebuild">Builds the answer again in place when an input changed before the commit (true: a new
    /// read-set holds); without it, or when it fails, the answer is withheld.</param>
    public static ObjectResult Guarded(ObjectResult answer, PrivacyResponseGuard guard, Func<bool>? rebuild = null)
        => answer is GuardedObjectResult ? answer : new GuardedObjectResult(answer, guard, rebuild);

    private sealed class GuardedObjectResult : ObjectResult
    {
        private readonly PrivacyResponseGuard _guard;
        private readonly Func<bool>? _rebuild;
        private readonly string[] _contentTypes;

        public GuardedObjectResult(ObjectResult inner, PrivacyResponseGuard guard, Func<bool>? rebuild) : base(inner.Value)
        {
            _guard = guard;
            _rebuild = rebuild;
            _contentTypes = inner.ContentTypes.ToArray();
            StatusCode = inner.StatusCode;
            DeclaredType = inner.DeclaredType;
            ContentTypes = inner.ContentTypes;
            Formatters = inner.Formatters;
        }

        public override async Task ExecuteResultAsync(ActionContext context)
        {
            _guard.Bind(context.HttpContext, owned: true);
            for (var attempt = 0; attempt < PrivacyDelivery.Attempts; attempt++)
            {
                // An input that changed before the last commit builds the answer again first, written from a clean
                // response (the host's executor folds the content type it chose into the result).
                if (attempt > 0)
                {
                    if (_rebuild?.Invoke() != true) break;
                    ContentTypes.Clear();
                    foreach (var type in _contentTypes) ContentTypes.Add(type);
                    context.HttpContext.Response.ContentType = null;
                    context.HttpContext.Response.ContentLength = null;
                    context.HttpContext.Response.StatusCode = StatusCode ?? StatusCodes.Status200OK;
                }
                await base.ExecuteResultAsync(context).ConfigureAwait(false);
                if (await _guard.TryCommitAsync().ConfigureAwait(false)) return;
                if (_guard.Stopped) return;
                _guard.Discard();
            }
            _guard.Stop();
        }
    }

    /// <summary>Makes the response's current body the held one (once per body); <paramref name="owned"/>: its writer commits it.</summary>
    internal void Bind(HttpContext http, bool owned = false)
    {
        lock (_lock) _owned |= owned;
        if (http.Response.Body is GuardedBody body && body.Guard == this) { _body = body; return; }
        _body = new GuardedBody(http.Response.Body, http.Features.Get<IHttpResponseBodyFeature>(), this);
        // Later projections can wrap this body. Their local held results still belong to this owner, but only this
        // outermost body may start the real transport and mark the answer committed.
        // Without a resource owner the host may replace its default body before executing a guarded result. That
        // replacement is the transport. Under the resource owner, replacements are inner projections instead.
        if (!_resourceOwned || _transportBody == null) _transportBody = _body;
        http.Response.Body = _body;
    }

    /// <summary>
    /// Replaces a set an answer was validated with by the set of its rebuild (the answer it guarded is no longer sent).
    /// </summary>
    public static void Replace(HttpContext http, PrivacyReadSet? old, PrivacyReadSet reads)
    {
        var guard = Of(http);
        lock (guard._lock)
        {
            if (old != null) guard._reads.Remove(old);
            if (!guard._reads.Contains(reads)) guard._reads.Add(reads);
        }
    }

    /// <summary>The response's guard (its body held from here on, once per response body).</summary>
    public static PrivacyResponseGuard Of(HttpContext http)
    {
        if (http.Response.Body is GuardedBody body) return body.Guard;
        if (http.Items[GuardKey] is PrivacyResponseGuard known)
        {
            known.Bind(http);
            return known;
        }
        var guard = new PrivacyResponseGuard(http);
        http.Items[GuardKey] = guard;
        guard.Bind(http);
        // Fail fast during header start. The writer barrier, not callback ordering, protects the remaining interval.
        try { http.Response.OnStarting(static state => ((PrivacyResponseGuard)state).OnStarting(), guard); }
        catch (InvalidOperationException) { }
        return guard;
    }

    private const string GuardKey = "__JE_PRIVACY_RESPONSE_GUARD";

    /// <summary>The response's guard, when it has one.</summary>
    internal static PrivacyResponseGuard? Find(HttpContext http) => http.Items[GuardKey] as PrivacyResponseGuard;

    /// <summary>
    /// The response's answer, when withheld here (its evidence or policy moved before it could leave), is exactly the
    /// route's plain 404 for something that doesn't exist: the same status and headers, no body, and no retry hint or
    /// diagnostic reason. For absent-title artwork, whose refusal must not be told apart from a missing image.
    /// </summary>
    /// <param name="http">The request.</param>
    internal static void WithholdAsAbsent(HttpContext http)
    {
        var guard = Of(http);
        lock (guard._lock) guard._withholdAsAbsent = true;
    }

    /// <summary>
    /// True when the parental evidence the response was admitted under has moved since (the guard would withhold its answer
    /// at the result or commit gate).
    /// </summary>
    /// <param name="http">The request.</param>
    /// <returns>Whether the evidence moved.</returns>
    internal static bool EvidenceMoved(HttpContext http)
    {
        if (Find(http) is not { } guard) return false;
        lock (guard._lock) return guard._evidence is { Current: false };
    }

    /// <summary>The plain 404 headers of an answer withheld as absent (see <see cref="WithholdAsAbsent"/>).</summary>
    /// <param name="headers">The response headers.</param>
    internal static void AbsentHeaders(IHeaderDictionary headers)
    {
        headers.Remove(ArtReasonHeader);
        headers.Remove("Retry-After");
        headers.CacheControl = "private, no-store";
        headers["X-Content-Type-Options"] = "nosniff";
    }

    /// <summary>The diagnostic reason header of a refused native answer; never part of a withheld answer.</summary>
    internal const string ArtReasonHeader = "X-JE-Art";

    /// <summary>
    /// Whether every read-set installed on the response still holds (the commit check; <paramref name="live"/>: the items
    /// the decisions read are compared with the host's live items too, which the header-commit check a moment later skips).
    /// </summary>
    public bool Holds(bool live = true)
    {
        using var timed = StageTimings.Time(Stage.Publish);
        if (!BackendHolds()) return false;
        PrivacyReadSet[] reads;
        lock (_lock)
        {
            if (_evidence is { Current: false }) return false;
            reads = _reads.ToArray();
        }
        foreach (var set in reads)
            if (!set.StillValid(live)) { PrivacyReadSet.Withheld(set); return false; }
        return true;
    }

    /// <summary>Whether a changed input stopped the response (nothing more is written).</summary>
    public bool Stopped => Volatile.Read(ref _stopped) != 0;

    /// <summary>Whether the answer was committed (validated and handed to the transport).</summary>
    public bool Committed
    {
        get { lock (_lock) return _committed; }
    }

    private Task OnStarting()
    {
        lock (_lock) { if (_detached) return Task.CompletedTask; _startChecked = true; }
        if (_titleFreeTransient)
        {
            _http.Response.Headers.CacheControl = "private, no-store";
            _http.Response.Headers.Remove("ETag");
            _http.Response.Headers.Remove("Last-Modified");
        }
        if (Stopped) { WithheldHeaders(); return Task.CompletedTask; }
        bool committing, held;
        lock (_lock) { committing = _committing; held = _body?.Held > 0 || _transportBody?.Held > 0; }
        // A protected answer whose writer never committed it: nothing of it leaves.
        if (!committing && held) { Stop(); return Task.CompletedTask; }
        if (!Holds(live: !committing)) Stop();
        return Task.CompletedTask;
    }

    /// <summary>
    /// Commits the held answer: validates every read-set, starts the response (the header-commit check runs there) and
    /// hands the bytes to the transport. False when an input changed before the start (the held bytes are kept for the
    /// caller to discard and build again) or when the answer was withheld at the header commit (<see cref="Stopped"/>).
    /// </summary>
    internal Task<bool> TryCommitAsync() => TryCommitBodyAsync(_body);

    private async Task<bool> TryCommitBodyAsync(GuardedBody? body)
    {
        if (Committed)
        {
            if (body != null) await body.ReleaseAsync().ConfigureAwait(false);
            return !Stopped;
        }
        if (Stopped || !Holds()) return false;
        if (body != null && body != _transportBody)
        {
            // A guarded result inside another projection hands bytes to that projection, never to the transport.
            // The outer body retains its dependency through all later projection/serialization work.
            await body.ReleaseAsync().ConfigureAwait(false);
            return !Stopped;
        }
        if (!TakeCommitToken()) { Stop(); return false; }
        lock (_lock) _committing = true;
        try
        {
            if (body?.Transport is { } transport) await transport.StartAsync().ConfigureAwait(false);
            else await _http.Response.StartAsync().ConfigureAwait(false);
        }
        catch
        {
            Dispose();
            throw;
        }
        finally
        {
            lock (_lock) _committing = false;
        }
        if (Stopped) { await WriteBackendFailureAsync().ConfigureAwait(false); return false; }
        // A host without start callbacks (an in-process context) is checked here instead.
        bool checkedAtStart;
        lock (_lock) checkedAtStart = _startChecked;
        if (!checkedAtStart && !Holds(live: false))
        {
            Stop();
            return false;
        }
        lock (_lock) _committed = true;
        try { if (body != null) await body.ReleaseAsync().ConfigureAwait(false); }
        catch { Dispose(); throw; }
        return true;
    }

    /// <summary>
    /// The commit at the end of an answer's result (the outermost resource filter calls it): a held answer is committed,
    /// or withheld when an input changed.
    /// </summary>
    public static async Task CommitAsync(HttpContext http)
    {
        if (Find(http) is not { } guard || guard.Committed) return;
        if (!guard.Stopped)
        {
            guard.Bind(http);
            if (!await guard.TryCommitAsync().ConfigureAwait(false)) guard.Stop();
        }
        await guard.WriteBackendFailureAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Finishes a held inner result before its enclosing projection finishes. This only hands bytes to that projection;
    /// the resource owner's pinned transport remains uncommitted and validates the final answer after all projections.
    /// </summary>
    internal static async Task CompleteProjectionAsync(HttpContext http)
    {
        if (Find(http) is not { } guard || guard.Stopped || guard._body is not { } body || body == guard._transportBody) return;
        if (!await guard.TryCommitBodyAsync(body).ConfigureAwait(false)) guard.Stop();
    }

    /// <summary>Drops the held bytes (an answer that is built and written again).</summary>
    internal void Discard()
    {
        _body?.Discard();
        _transportBody?.Discard();
    }

    /// <summary>
    /// Stops the response: before the start it becomes an empty, uncached 503 (the answer is withheld); after (an answer
    /// larger than <see cref="MaxHeld"/>), the connection is aborted.
    /// </summary>
    internal void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        Dispose();
        Discard();
        var response = _http.Response;
        if (!response.HasStarted) { WithheldHeaders(); return; }
        _http.Abort();
    }

    private void WithheldHeaders()
    {
        var response = _http.Response;
        // A withheld answer carries no diagnostic reason of the answer it replaces.
        response.Headers.Remove(ArtReasonHeader);
        bool absent;
        lock (_lock) absent = _withholdAsAbsent;
        if (absent && _backendFailure == null)
        {
            // Exactly the route's plain 404: status, headers and an empty body (nothing of the held answer leaves).
            response.StatusCode = StatusCodes.Status404NotFound;
            response.Headers.Remove("Content-Length");
            response.Headers.Remove("ETag");
            response.Headers.Remove("Last-Modified");
            response.Headers.Remove("Content-Type");
            response.Headers.Remove("Content-Disposition");
            response.Headers.Remove("Content-Range");
            response.Headers.Remove("Accept-Ranges");
            AbsentHeaders(response.Headers);
            return;
        }

        response.StatusCode = _backendFailure == null ? StatusCodes.Status503ServiceUnavailable : StatusCodes.Status409Conflict;
        response.ContentLength = _backendFailure == null ? 0 : BackendFailureBody().Length;
        response.Headers.CacheControl = "private, no-store";
        response.Headers.Remove("ETag");
        response.Headers.Remove("Last-Modified");
        response.Headers.Remove("Content-Type");
        response.Headers.Remove("Content-Disposition");
        response.Headers.Remove("Content-Range");
        response.Headers.Remove("Accept-Ranges");
        if (_backendFailure == null) response.Headers["Retry-After"] = "1";
        else
        {
            response.Headers.Remove("Retry-After");
            response.ContentType = "application/json";
        }
    }

    private byte[] BackendFailureBody() => System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { code = _backendFailure, error = true });

    private async Task WriteBackendFailureAsync()
    {
        if (_backendFailure == null || !Stopped || HttpMethods.IsHead(_http.Request.Method)
            || _http.RequestAborted.IsCancellationRequested || Interlocked.Exchange(ref _backendFailureSent, 1) != 0) return;
        if (_transportBody is { } transport) await transport.WriteFailureAsync(BackendFailureBody()).ConfigureAwait(false);
    }

    /// <summary>
    /// A result that confirms the client's copy (a 304, which writes no bytes): decided at the header commit, so it leaves
    /// only while the response's read-sets hold; otherwise the answer is withheld.
    /// </summary>
    public static IActionResult Confirm(HttpContext http, IActionResult notModified) => new ConfirmedResult(Of(http), notModified);

    private sealed class ConfirmedResult(PrivacyResponseGuard guard, IActionResult inner) : IActionResult, Microsoft.AspNetCore.Mvc.Infrastructure.IStatusCodeActionResult
    {
        public int? StatusCode => (inner as Microsoft.AspNetCore.Mvc.Infrastructure.IStatusCodeActionResult)?.StatusCode;

        public async Task ExecuteResultAsync(ActionContext context)
        {
            guard.Bind(context.HttpContext, owned: true);
            if (!guard.Holds()) { guard.Stop(); return; }
            await inner.ExecuteResultAsync(context).ConfigureAwait(false);
            if (!await guard.TryCommitAsync().ConfigureAwait(false)) guard.Stop();
        }
    }

    /// <summary>Whether the response's writer commits it itself (else the declared length or the result's end does).</summary>
    private bool Owned
    {
        get { lock (_lock) return _owned; }
    }

    /// <summary>
    /// A writer that commits its answer itself (the tag cache's segments, a guarded result): the declared length does not
    /// commit it.
    /// </summary>
    internal void Own() { lock (_lock) _owned = true; }

    /// <summary>Pins the outer transport before any resource projection can replace the body.</summary>
    internal void OwnTransport(bool rawDownloadCandidate = false)
    {
        lock (_lock) { _resourceOwned = true; _owned = true; _rawDownloadCandidate = rawDownloadCandidate; }
    }

    // The mixed native download route retains its outer anchor until the concrete file executor runs. No existing
    // classification or already-written bytes can be reclassified here. Keep wrappers in place for inner projections.
    internal void StreamRawDownload(ActionContext context, IActionResult result)
    {
        if (!_rawDownloadCandidate || !MediaResponseContract.RawDownload(context, result)) return;
        lock (_lock)
        {
            if (_reads.Count != 0 || _evidence != null || _finished || Stopped || _committed
                || _body?.Held > 0 || _transportBody?.Held > 0) return;
            _body?.ReleaseEmpty();
            _transportBody?.ReleaseEmpty();
            _detached = true;
            _committed = true;
        }
    }

    /// <summary>
    /// The response body: every write is held until the commit. The declared length reached (an answer whose writer does
    /// not commit it itself) or <see cref="MaxHeld"/> commits it; after the commit, writes go to the transport.
    /// </summary>
    private sealed class GuardedBody(Stream inner, IHttpResponseBodyFeature? transport, PrivacyResponseGuard guard) : Stream
    {
        private readonly List<byte[]> _held = new();
        private long _length;
        private bool _released;
        private readonly object _lock = new();

        public PrivacyResponseGuard Guard { get; } = guard;

        /// <summary>The host's body feature under this one (what the commit starts).</summary>
        public IHttpResponseBodyFeature? Transport { get; } = transport;

        /// <summary>How many bytes are held.</summary>
        public long Held
        {
            get { lock (_lock) return _length; }
        }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public void Discard()
        {
            lock (_lock)
            {
                if (_released) return;
                _held.Clear();
                _length = 0;
            }
        }

        public void ReleaseEmpty()
        {
            lock (_lock)
            {
                if (_length != 0) throw new InvalidOperationException("A written answer cannot become raw media.");
                _released = true;
            }
        }

        /// <summary>Hands the held bytes to the transport (the commit).</summary>
        internal async Task WriteFailureAsync(byte[] body)
        {
            await inner.WriteAsync(body).ConfigureAwait(false);
            await inner.FlushAsync().ConfigureAwait(false);
        }

        public async Task ReleaseAsync()
        {
            byte[][] held;
            lock (_lock)
            {
                if (_released) return;
                _released = true;
                held = _held.ToArray();
                _held.Clear();
                _length = 0;
            }
            foreach (var chunk in held) await inner.WriteAsync(chunk).ConfigureAwait(false);
            if (held.Length > 0) await inner.FlushAsync().ConfigureAwait(false);
        }

        private bool Released
        {
            get { lock (_lock) return _released; }
        }

        /// <summary>Holds <paramref name="buffer"/>; true when the answer is now complete or at the bound (to be committed).</summary>
        private bool Hold(ReadOnlySpan<byte> buffer)
        {
            lock (_lock)
            {
                if (buffer.Length > 0)
                {
                    _held.Add(buffer.ToArray());
                    _length += buffer.Length;
                }
                if (_length >= MaxHeld) return true;
                return !Guard.Owned && Guard._http.Response.ContentLength is { } declared && declared > 0 && _length >= declared;
            }
        }

        private async Task CommitHeldAsync()
        {
            if (!await Guard.TryCommitBodyAsync(this).ConfigureAwait(false)) Guard.Stop();
        }

        public override void Flush()
        {
            if (Released && !Guard.Stopped) inner.Flush();
        }

        public override Task FlushAsync(CancellationToken cancellationToken)
            => Released && !Guard.Stopped ? inner.FlushAsync(cancellationToken) : Task.CompletedTask;

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (Guard.Stopped) return;
            if (Released) { inner.Write(buffer); return; }
            if (Hold(buffer)) CommitHeldAsync().GetAwaiter().GetResult();
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Guard.Stopped) return;
            if (Released) { await inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false); return; }
            if (Hold(buffer.Span)) await CommitHeldAsync().ConfigureAwait(false);
        }

        // The host owns the stream it handed the response (disposing the wrapper leaves it open).
        protected override void Dispose(bool disposing) { if (disposing) Guard.Dispose(); }

        public override ValueTask DisposeAsync() { Guard.Dispose(); return ValueTask.CompletedTask; }
    }
}

/// <summary>
/// The commit at the end of every protected MVC answer, outside every resource filter including legacy collage projection. Only
/// this owner's outermost held body starts the transport, after the result and every inner projection completed. Local
/// guarded results may hand their bytes to a projection, but cannot mark that handoff as an HTTP commit.
/// </summary>
public sealed class PrivacyCommitFilter : IAsyncResourceFilter, IAlwaysRunResultFilter, IOrderedFilter
{
    /// <inheritdoc />
    public int Order => Acquire.Lists.LegacyCollageBody.Order - 1;

    /// <inheritdoc />
    public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
    {
        var http = context.HttpContext;
        // Unknown/unclassified host actions can return title DTOs: they still need an outer commit owner. Only the
        // host's explicit raw-media contract may stream without one, decided here before content type or body exists.
        // An existing guard or privacy/evidence admission always takes precedence over the streaming exception.
        var owns = PrivacyResponseGuard.Owns(context.ActionDescriptor);
        var existing = PrivacyResponseGuard.Find(http);
        if (owns || existing != null || !MediaResponseContract.Streams(context.ActionDescriptor))
            PrivacyResponseGuard.Of(http).OwnTransport(!owns && existing == null && MediaResponseContract.Download(context.ActionDescriptor));
        if (owns)
        {
            // Admission precedes evidence reads; the token spans all remaining host callbacks and transport completion.
            PrivacyResponseGuard.AdmitAction(http, context.ActionDescriptor, http.RequestServices.GetService<SeerrParentalFilter>(), UserHelper.GetCurrentUserId(http.User));
        }
        ResourceExecutedContext executed;
        try { executed = await next().ConfigureAwait(false); }
        catch { PrivacyResponseGuard.Find(http)?.HandBackError(); throw; }
        if (executed.Exception != null && !executed.ExceptionHandled)
        {
            // MVC rethrows this to the host. Do not commit its pending answer or preempt the host's error status.
            PrivacyResponseGuard.Find(http)?.HandBackError();
            return;
        }
        await PrivacyResponseGuard.CommitAsync(http).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public void OnResultExecuting(ResultExecutingContext context)
    {
        if (!PrivacyResponseGuard.BeforeResult(context)) return;
        if (MediaResponseContract.Download(context.ActionDescriptor) && context.Result.GetType() == typeof(PhysicalFileResult))
            context.Result = new DownloadResult(context.Result);
    }

    private sealed class DownloadResult(IActionResult inner) : IActionResult
    {
        public async Task ExecuteResultAsync(ActionContext context)
        {
            var guard = PrivacyResponseGuard.Of(context.HttpContext);
            guard.Bind(context.HttpContext, owned: true);
            if (!guard.Holds()) { guard.Stop(); return; }
            guard.StreamRawDownload(context, inner);
            await inner.ExecuteResultAsync(context).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public void OnResultExecuted(ResultExecutedContext context) { }
}
