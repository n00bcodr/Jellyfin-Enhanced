#if JF12
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Admits and schedules the feed reads viewers make the server start upstream:
    /// <see cref="Concurrency"/> run at once and <see cref="Queue"/> more may wait, server-wide;
    /// one viewer has at most <see cref="PerViewer"/> of them outstanding (running or waiting, until
    /// the read ends). A free upstream slot goes to the viewers with waiting reads in turn, so one
    /// viewer's queued reads never hold another's back for more than one slot each.
    /// </summary>
    internal sealed class FeedScheduler
    {
        private readonly object _lock = new();
        private readonly Dictionary<Guid, Viewer> _viewers = new();
        private readonly Queue<Guid> _turns = new();
        private int _outstanding;
        private int _running;

        /// <summary>Creates a scheduler.</summary>
        /// <param name="concurrency">Reads running upstream at once.</param>
        /// <param name="queue">Reads that may wait for an upstream slot.</param>
        /// <param name="perViewer">Reads one viewer may have outstanding.</param>
        internal FeedScheduler(int concurrency, int queue, int perViewer)
        {
            Concurrency = concurrency;
            Queue = queue;
            PerViewer = perViewer;
        }

        /// <summary>Reads running upstream at once, server-wide.</summary>
        internal int Concurrency { get; }

        /// <summary>Reads that may wait for an upstream slot, server-wide.</summary>
        internal int Queue { get; }

        /// <summary>Reads one viewer may have outstanding, running or waiting.</summary>
        internal int PerViewer { get; }

        /// <summary>Reads admitted and not ended, running or waiting.</summary>
        internal int Outstanding
        {
            get
            {
                lock (_lock) return _outstanding;
            }
        }

        /// <summary>Viewers with a read outstanding (an entry lives only while its count is above zero).</summary>
        internal int ViewersTracked
        {
            get
            {
                lock (_lock) return _viewers.Count;
            }
        }

        /// <summary>The viewer's outstanding reads.</summary>
        /// <param name="viewer">The viewer.</param>
        /// <returns>Their running and waiting reads.</returns>
        internal int OutstandingOf(Guid viewer)
        {
            lock (_lock) return _viewers.TryGetValue(viewer, out var v) ? v.Outstanding : 0;
        }

        /// <summary>Takes a place for a new read when the server and the viewer both have room.</summary>
        /// <param name="viewer">The viewer the read is for.</param>
        /// <returns>True when admitted; the place is then held until <see cref="Leave"/>.</returns>
        internal bool TryAdmit(Guid viewer)
        {
            lock (_lock)
            {
                if (_outstanding >= Concurrency + Queue) return false;
                if (!_viewers.TryGetValue(viewer, out var v))
                {
                    v = new Viewer();
                    _viewers[viewer] = v;
                }

                if (v.Outstanding >= PerViewer) return false;
                v.Outstanding++;
                _outstanding++;
                return true;
            }
        }

        /// <summary>Waits for an upstream slot for an admitted read (never cancelled: the read owns it).</summary>
        /// <param name="viewer">The viewer the read was admitted for.</param>
        /// <returns>Completes when the read may go upstream.</returns>
        internal Task TurnAsync(Guid viewer)
        {
            lock (_lock)
            {
                if (_running < Concurrency && _turns.Count == 0)
                {
                    _running++;
                    return Task.CompletedTask;
                }

                var v = _viewers[viewer];
                var turn = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                if (v.Waiting.Count == 0) _turns.Enqueue(viewer);
                v.Waiting.Enqueue(turn);
                return turn.Task;
            }
        }

        /// <summary>Ends an admitted read: frees its place and, when it ran, hands its slot to the next viewer in turn.</summary>
        /// <param name="viewer">The viewer the read was admitted for.</param>
        /// <param name="ran">True when the read had its upstream slot.</param>
        internal void Leave(Guid viewer, bool ran)
        {
            TaskCompletionSource? next = null;
            lock (_lock)
            {
                if (_viewers.TryGetValue(viewer, out var v) && --v.Outstanding <= 0 && v.Waiting.Count == 0) _viewers.Remove(viewer);
                _outstanding--;
                if (ran)
                {
                    _running--;
                    if (_running < Concurrency && _turns.Count > 0)
                    {
                        var who = _turns.Dequeue();
                        var w = _viewers[who];
                        next = w.Waiting.Dequeue();
                        // Back of the line: every other viewer waiting gets a slot before this one's next read.
                        if (w.Waiting.Count > 0) _turns.Enqueue(who);
                        _running++;
                    }
                }
            }

            next?.SetResult();
        }

        private sealed class Viewer
        {
            internal int Outstanding;

            internal Queue<TaskCompletionSource> Waiting { get; } = new();
        }
    }
}
#endif
