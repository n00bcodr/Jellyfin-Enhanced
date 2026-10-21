using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The delivery gate at the byte boundary. A protected answer's bytes leave after the gate validated its read-set — a
/// deferred result executor serializes later, a slow client makes each write wait — so every write of a gated response
/// re-checks the read-sets its answer was validated with: before anything was sent, a changed input withholds the answer
/// (503, never cached); after sending started, the response is aborted, so no byte built under the old verdict follows the
/// change. Validators are confirmed the same way: a 304 leaves only while the read-set that made its ETag still holds
/// (<see cref="Confirm"/>).
/// </summary>
public sealed class PrivacyResponseGuard
{
    private readonly HttpContext _http;
    private readonly List<PrivacyReadSet> _reads = new();
    private readonly object _lock = new();
    private int _stopped;

    private PrivacyResponseGuard(HttpContext http) => _http = http;

    /// <summary>
    /// Guards the response of <paramref name="http"/> with <paramref name="reads"/> (an answer validated with it is in the
    /// response): its body is wrapped once, and every write re-checks every set installed on it.
    /// </summary>
    public static PrivacyResponseGuard? Install(HttpContext? http, PrivacyReadSet reads)
    {
        if (http == null) return null;
        var guard = Of(http);
        lock (guard._lock) if (!guard._reads.Contains(reads)) guard._reads.Add(reads);
        return guard;
    }

    /// <summary>
    /// The host's object answer, executed through the guard: when it executes, the response body it writes to (even one
    /// set after the gate ran) is the guarded body.
    /// </summary>
    /// <param name="answer">The answer.</param>
    /// <param name="guard">The response's guard.</param>
    /// <param name="rebuild">Builds the answer again in place when an input changed before its first byte (true: a new
    /// read-set holds); without it, or when it fails, the answer is withheld.</param>
    public static ObjectResult Guarded(ObjectResult answer, PrivacyResponseGuard guard, Func<bool>? rebuild = null)
        => answer is GuardedObjectResult ? answer : new GuardedObjectResult(answer, guard, rebuild);

    private sealed class GuardedObjectResult : ObjectResult
    {
        private readonly PrivacyResponseGuard _guard;
        private readonly Func<bool>? _rebuild;

        public GuardedObjectResult(ObjectResult inner, PrivacyResponseGuard guard, Func<bool>? rebuild) : base(inner.Value)
        {
            _guard = guard;
            _rebuild = rebuild;
            StatusCode = inner.StatusCode;
            DeclaredType = inner.DeclaredType;
            ContentTypes = inner.ContentTypes;
            Formatters = inner.Formatters;
        }

        public override Task ExecuteResultAsync(ActionContext context)
        {
            _guard.Bind(context.HttpContext);
            // Before anything is sent: an input that changed since the gate builds the answer again (bounded), or withholds it.
            if (!_guard.Holds() && !(_rebuild?.Invoke() == true && _guard.Holds()))
            {
                _guard.Stop();
                return Task.CompletedTask;
            }
            return base.ExecuteResultAsync(context);
        }
    }

    /// <summary>Makes the response's current body the guarded one (once per body).</summary>
    private void Bind(HttpContext http)
    {
        if (http.Response.Body is GuardedBody body && body.Guard == this) return;
        http.Response.Body = new GuardedBody(http.Response.Body, this);
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

    /// <summary>The response's guard (its body wrapped, once per response body).</summary>
    public static PrivacyResponseGuard Of(HttpContext http)
    {
        if (http.Response.Body is GuardedBody body) return body.Guard;
        var guard = new PrivacyResponseGuard(http);
        http.Response.Body = new GuardedBody(http.Response.Body, guard);
        return guard;
    }

    /// <summary>Whether every read-set installed on the response still holds (the check before each write).</summary>
    public bool Holds()
    {
        PrivacyReadSet[] reads;
        lock (_lock) reads = _reads.ToArray();
        foreach (var set in reads)
            if (!set.StillValid()) return false;
        return true;
    }

    /// <summary>Whether a changed input stopped the response (nothing more is written).</summary>
    public bool Stopped => Volatile.Read(ref _stopped) != 0;

    /// <summary>
    /// Stops the response: before anything was sent it becomes an empty, uncached 503 (the answer is withheld); after, the
    /// connection is aborted.
    /// </summary>
    internal void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        var response = _http.Response;
        if (!response.HasStarted)
        {
            response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            response.ContentLength = 0;
            response.Headers.CacheControl = "private, no-store";
            response.Headers.Remove("ETag");
            response.Headers.Remove("Last-Modified");
            return;
        }
        _http.Abort();
    }

    /// <summary>
    /// A result that confirms the client's copy (a 304, which writes no bytes the body guard could check): it leaves only
    /// while the response's read-sets hold; otherwise the answer is withheld.
    /// </summary>
    public static IActionResult Confirm(HttpContext http, IActionResult notModified) => new ConfirmedResult(Of(http), notModified);

    private sealed class ConfirmedResult(PrivacyResponseGuard guard, IActionResult inner) : IActionResult, Microsoft.AspNetCore.Mvc.Infrastructure.IStatusCodeActionResult
    {
        public int? StatusCode => (inner as Microsoft.AspNetCore.Mvc.Infrastructure.IStatusCodeActionResult)?.StatusCode;

        public Task ExecuteResultAsync(ActionContext context)
        {
            if (guard.Holds()) return inner.ExecuteResultAsync(context);
            guard.Stop();
            return Task.CompletedTask;
        }
    }

    /// <summary>
    /// The response body: every write is preceded by the guard's check. The first write sends its first byte alone and
    /// checks again before the rest, so a wait at the start of sending (a slow client) never carries a whole answer
    /// built under inputs that changed during it.
    /// </summary>
    private sealed class GuardedBody(Stream inner, PrivacyResponseGuard guard) : Stream
    {
        public PrivacyResponseGuard Guard { get; } = guard;

        private bool _started;

        private bool Proceed()
        {
            if (Guard.Stopped) return false;
            if (Guard.Holds()) return true;
            Guard.Stop();
            return false;
        }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Flush()
        {
            if (!Guard.Stopped) inner.Flush();
        }

        public override Task FlushAsync(CancellationToken cancellationToken)
            => Guard.Stopped ? Task.CompletedTask : inner.FlushAsync(cancellationToken);

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (!Proceed()) return;
            if (!_started && buffer.Length > 1)
            {
                _started = true;
                inner.Write(buffer[..1]);
                if (!Proceed()) return;
                buffer = buffer[1..];
            }
            _started = true;
            inner.Write(buffer);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (!Proceed()) return;
            if (!_started && buffer.Length > 1)
            {
                _started = true;
                await inner.WriteAsync(buffer[..1], cancellationToken).ConfigureAwait(false);
                if (!Proceed()) return;
                buffer = buffer[1..];
            }
            _started = true;
            await inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
        }

        // The host owns the stream it handed the response (disposing the wrapper leaves it open).
        protected override void Dispose(bool disposing) { }

        public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
