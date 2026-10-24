using System;
using System.Diagnostics;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Serializes evidence changes with the final-check-to-completion interval of bounded title responses.</summary>
internal static class EvidenceRevision
{
    // A stalled client must not make settings unusable. Normal bounded JSON/artwork completes well inside this budget.
    internal const int DrainMilliseconds = 3000;
    private static readonly object State = new();
    private static int _active;
    private static int _writers;
    private static long _current;
    [ThreadStatic] private static int _mutationDepth;

    internal static long Current { get { lock (State) return _current; } }
    internal static int Outstanding { get { lock (State) return _active; } }
    internal static bool Advancing { get { lock (State) return _writers != 0; } }

    // Validation and admission are indivisible with the writer closing admissions. Never wait here: fail closed instead.
    internal static IDisposable? TryAcquire(Func<bool> validate)
    {
        lock (State)
        {
            if (_writers != 0 || !validate()) return null;
            _active++;
            return new Token();
        }
    }

    internal static void Advance(Action mutation, Logger? logger = null)
    {
        // Configuration replacement calls SaveConfiguration and SecretsStore.Update synchronously. They share one drain.
        if (_mutationDepth != 0) { mutation(); return; }
        using var writer = Advance(logger);
        _mutationDepth++;
        try { mutation(); }
        finally { _mutationDepth--; }
    }

    // Jellyfin's synchronous pre/post replacement events cannot use a lexical finally in plugin code. Its writer lease
    // additionally expires if the host throws before ConfigurationUpdated; late completion after expiry is a logged limit.
    internal static IDisposable Advance(Logger? logger = null, bool hostUpdate = false)
    {
        logger ??= JellyfinEnhanced.Instance?.EvidenceLogger;
        int remaining;
        var clock = Stopwatch.StartNew();
        lock (State)
        {
            _writers++;
            while (_active != 0)
            {
                var left = DrainMilliseconds - (int)clock.ElapsedMilliseconds;
                if (left <= 0) break;
                Monitor.Wait(State, left);
            }
            remaining = _active;
        }
        if (remaining != 0) logger?.Warning($"Parental evidence revision drain expired after {DrainMilliseconds} ms; outstanding responses: {remaining}.");
        return new Writer(logger, hostUpdate);
    }

    private sealed class Token : IDisposable
    {
        private int _disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            lock (State) { _active--; Monitor.PulseAll(State); }
        }
    }

    private sealed class Writer : IDisposable
    {
        private int _disposed;
        private readonly Timer? _abandoned;
        private readonly Logger? _logger;
        internal Writer(Logger? logger, bool hostUpdate)
        {
            _logger = logger;
            if (hostUpdate) _abandoned = new Timer(_ => Expire(), null, DrainMilliseconds, Timeout.Infinite);
        }
        private void Expire()
        {
            if (!Finish()) return;
            _logger?.Warning($"Parental evidence host update did not finish within {DrainMilliseconds} ms; admissions reopened after bounded cleanup.");
        }
        private bool Finish()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return false;
            lock (State) { _current++; _writers--; Monitor.PulseAll(State); }
            return true;
        }
        public void Dispose() { Finish(); _abandoned?.Dispose(); }
    }
}
