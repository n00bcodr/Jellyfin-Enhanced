using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest
{
    /// <summary>One playback moment a recipe may act on, captured on the event thread.</summary>
    /// <param name="Key">Dedupe key: recipe, event kind, user and item.</param>
    /// <param name="UserId">The person watching.</param>
    /// <param name="UserName">Their name, for the log only.</param>
    /// <param name="Item">The item played.</param>
    public sealed record PlaybackTrigger(string Key, Guid UserId, string? UserName, BaseItem Item);

    /// <summary>
    /// The hand-off between Jellyfin's playback events and the recipe worker. An event handler calls
    /// <see cref="TryWrite"/>, which takes constant time, does no I/O and never waits; one worker runs the
    /// recipes in order. Bounded: at most <c>capacity</c> distinct triggers wait, and a repeat of a waiting
    /// trigger replaces it instead of taking another slot (progress events repeat every few seconds), so a
    /// stop event is never queued behind a pile of progress events. A trigger refused because the queue is
    /// full or closed is counted and logged, never silently dropped.
    /// </summary>
    public sealed class PlaybackTriggerChannel : IDisposable
    {
        private readonly object _lock = new();
        private readonly Dictionary<string, PlaybackTrigger> _pending = new(StringComparer.Ordinal);
        private readonly Channel<string> _keys;
        private readonly int _capacity;
        private readonly Func<PlaybackTrigger, CancellationToken, Task> _process;
        private readonly Action<string> _log;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _worker;
        private bool _closed;
        private long _dropped;
        private long _coalesced;
        private long _lastDropLog = -1;

        /// <summary>Starts the worker.</summary>
        /// <param name="capacity">Most distinct triggers waiting.</param>
        /// <param name="process">The recipe; its exceptions are logged and never stop the worker.</param>
        /// <param name="log">Warning log.</param>
        public PlaybackTriggerChannel(int capacity, Func<PlaybackTrigger, CancellationToken, Task> process, Action<string> log)
        {
            _capacity = Math.Max(1, capacity);
            _keys = Channel.CreateBounded<string>(new BoundedChannelOptions(_capacity) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
            _process = process;
            _log = log;
            _worker = Task.Run(RunAsync);
        }

        /// <summary>The production capacity.</summary>
        public const int DefaultCapacity = 1024;

        /// <summary>Triggers refused because the queue was full.</summary>
        public long Dropped => Interlocked.Read(ref _dropped);

        /// <summary>Triggers that replaced a waiting repeat of themselves.</summary>
        public long Coalesced => Interlocked.Read(ref _coalesced);

        /// <summary>Triggers waiting.</summary>
        public int Waiting
        {
            get { lock (_lock) return _pending.Count; }
        }

        /// <summary>Queues a trigger without waiting (event-thread safe); false when refused (full or closed).</summary>
        public bool TryWrite(PlaybackTrigger trigger)
        {
            string? warning = null;
            var accepted = false;
            lock (_lock)
            {
                if (_closed)
                {
                    warning = "Playback work admission failed: the queue is closed.";
                }
                else if (_pending.ContainsKey(trigger.Key))
                {
                    _pending[trigger.Key] = trigger;
                    Interlocked.Increment(ref _coalesced);
                    accepted = true;
                }
                else if (_pending.Count >= _capacity || !_keys.Writer.TryWrite(trigger.Key))
                {
                    var dropped = Interlocked.Increment(ref _dropped);
                    // One line per burst of drops (the first, then every 1,000th).
                    if (_lastDropLog < 0 || dropped - _lastDropLog >= 1000)
                    {
                        _lastDropLog = dropped;
                        warning = $"Playback work admission failed: {_capacity} triggers are already waiting ({dropped} refused so far).";
                    }
                }
                else
                {
                    _pending[trigger.Key] = trigger;
                    accepted = true;
                }
            }
            if (warning != null) _log(warning);
            return accepted;
        }

        private async Task RunAsync()
        {
            try
            {
                await foreach (var key in _keys.Reader.ReadAllAsync(_stop.Token).ConfigureAwait(false))
                {
                    PlaybackTrigger? trigger;
                    lock (_lock)
                    {
                        if (!_pending.Remove(key, out trigger)) continue;
                    }
                    try
                    {
                        await _process(trigger!, _stop.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (_stop.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (Exception ex)
                    {
                        _log("Playback work failed: " + ex.GetType().Name);
                    }
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
                // Shutdown.
            }
        }

        /// <summary>Stops admission, gives waiting triggers a few seconds to drain, then stops the worker.</summary>
        public void Dispose()
        {
            lock (_lock)
            {
                if (_closed) return;
                _closed = true;
                _keys.Writer.TryComplete();
            }
            if (!_worker.Wait(TimeSpan.FromSeconds(5))) _stop.Cancel();
            try
            {
                if (_worker.Wait(TimeSpan.FromSeconds(1))) _stop.Dispose();
            }
            catch (AggregateException)
            {
                // The worker ended with an error that was already logged.
            }
        }
    }
}
