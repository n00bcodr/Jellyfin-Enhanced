using System;
using System.Diagnostics;
using System.Threading;
using System.Security.Cryptography;
using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Serializes evidence changes with the final-check-to-completion interval of bounded title responses.</summary>
internal static class EvidenceRevision
{
    // A stalled client must not make settings unusable. Normal bounded JSON/artwork completes well inside this budget.
    internal const int DrainMilliseconds = 3000;
    private static readonly object State = new();
    private static int _active;
    private static int _writers;
    // A fresh 62-bit startup nonce prevents an earlier process's cache/dependency from being reused.
    // Only Advance's writer completion (or a nested Advance) moves this counter after initialization.
    private static long _current = BitConverter.ToInt64(RandomNumberGenerator.GetBytes(8)) & 0x3FFFFFFFFFFFFFFF;
    [ThreadStatic] private static int _snapshotDepth;
    [ThreadStatic] private static int _mutationDepth;

    internal static long EvidenceGeneration => Current;
    internal static bool ReadingSnapshot => _snapshotDepth != 0 || Monitor.IsEntered(State);
    internal static T Snapshot<T>(Func<T> read)
    {
        _snapshotDepth++;
        try { return read(); } finally { _snapshotDepth--; }
    }

    internal static long Current { get { lock (State) return _current; } }
    internal static int Outstanding { get { lock (State) return _active; } }
    internal static bool Advancing { get { lock (State) return _writers != 0; } }

    // Reflection-based patching cannot bypass the same input writer used by direct assignments.
    internal static bool IsConfigurationInput(string name) => name is nameof(PluginConfiguration.TMDB_API_KEY)
        or nameof(PluginConfiguration.JellyseerrApiKey) or nameof(PluginConfiguration.ArrRequestBackend) or nameof(PluginConfiguration.JellyseerrEnabled) or nameof(PluginConfiguration.JellyseerrUrls);

    internal static void AssignConfigurationValue(PluginConfiguration target, PropertyInfo property, object? value)
    {
        if (IsConfigurationInput(property.Name)) Advance(() => property.SetValue(target, value));
        else AssignUnrelatedValue(target, property, value);
    }

    private static void AssignUnrelatedValue(PluginConfiguration target, PropertyInfo property, object? value)
    {
        if (IsConfigurationInput(property.Name)) throw new InvalidOperationException("An evidence input requires Advance.");
        property.SetValue(target, value);
    }

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
        if (_mutationDepth != 0)
        {
            try { mutation(); }
            finally { lock (State) _current = checked(_current + 1); }
            return;
        }
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
            lock (State) { _current = checked(_current + 1); _writers--; Monitor.PulseAll(State); }
            return true;
        }
        public void Dispose() { Finish(); _abandoned?.Dispose(); }
    }
}
