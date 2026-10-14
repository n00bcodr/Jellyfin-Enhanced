using System;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>Lossless handoff for legacy playback recipes; event callbacks return without doing I/O.</summary>
    internal sealed class PlaybackWorkQueue : IDisposable
    {
        private readonly Channel<Func<Task>> _channel = Channel.CreateUnbounded<Func<Task>>(new UnboundedChannelOptions { SingleReader = true });
        private readonly Action<string> _log;
        private readonly Task _worker;
        /// <summary>Starts the worker with recipe logging for failed admission and execution.</summary>
        public PlaybackWorkQueue(Action<string> log) { _log = log; _worker = Task.Run(RunAsync); }
        /// <summary>Admits a playback callback without a capacity limit; shutdown refusals are logged.</summary>
        public void Enqueue(Func<Task> work)
        {
            if (!_channel.Writer.TryWrite(work)) _log("Playback work admission failed: the queue is closed.");
        }
        private async Task RunAsync()
        {
            await foreach (var work in _channel.Reader.ReadAllAsync().ConfigureAwait(false))
            {
                try { await work().ConfigureAwait(false); }
                catch (Exception ex) { _log("Playback work failed: " + ex.GetType().Name); }
            }
        }
        /// <summary>Stops admission and gives already admitted callbacks time to drain.</summary>
        public void Dispose()
        {
            _channel.Writer.TryComplete();
            _worker.Wait(TimeSpan.FromSeconds(5));
        }
    }
}
