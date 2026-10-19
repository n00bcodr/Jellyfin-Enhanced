using System;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Holds Jellyfin Enhanced's own Seerr request writes (the request proxy, the Requests page's approve and
    /// decline, the outbox's Seerr sends) off while a move from Seerr runs. A write enters before its first
    /// await and holds its pass until it is done; a move starts only once the writes already in flight have
    /// finished, and refuses new ones until it ends. Changes made in Seerr's own interface can't be held off;
    /// the move's read notices those up to its final check.
    /// </summary>
    public sealed class SeerrRequestWriteFence
    {
        private readonly object _lock = new();
        private int _writers;
        private bool _moving;
        private TaskCompletionSource? _drained;

        /// <summary>True while a move runs.</summary>
        public bool Moving
        {
            get { lock (_lock) return _moving; }
        }

        /// <summary>Lets one Seerr request write through; null while a move runs (refuse the write).</summary>
        /// <returns>A pass to dispose when the write is done, or null.</returns>
        public IDisposable? TryEnterWrite()
        {
            lock (_lock)
            {
                if (_moving) return null;
                _writers++;
                return new Pass(ExitWrite);
            }
        }

        /// <summary>
        /// Starts a move: new writes are refused at once, and this waits (at most <paramref name="drain"/>)
        /// for the writes in flight to finish. Null when they didn't finish in time (nothing is held then).
        /// </summary>
        /// <param name="drain">How long to wait for writes in flight.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>A pass that ends the move when disposed, or null.</returns>
        public async Task<IDisposable?> BeginMoveAsync(TimeSpan drain, CancellationToken ct)
        {
            Task wait;
            lock (_lock)
            {
                if (_moving) return null;
                _moving = true;
                if (_writers == 0) return new Pass(EndMove);
                _drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                wait = _drained.Task;
            }
            try
            {
                await wait.WaitAsync(drain, ct).ConfigureAwait(false);
                return new Pass(EndMove);
            }
            catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
            {
                EndMove();
                if (ex is OperationCanceledException) throw;
                return null;
            }
        }

        private void ExitWrite()
        {
            lock (_lock)
            {
                if (--_writers == 0) _drained?.TrySetResult();
            }
        }

        private void EndMove()
        {
            lock (_lock)
            {
                _moving = false;
                _drained = null;
            }
        }

        private sealed class Pass(Action release) : IDisposable
        {
            private Action? _release = release;

            public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
        }
    }
}
