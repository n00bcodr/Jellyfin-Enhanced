using System;
using System.Collections.Concurrent;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// A per-viewer token bucket for upstream work one viewer can make the server start (artwork
    /// fetches, discovery feed pages): <see cref="Burst"/> at once, then <see cref="PerSecond"/> a
    /// second. Work served from a cache never takes from it.
    /// </summary>
    internal sealed class ViewerBudget
    {
        private readonly ConcurrentDictionary<Guid, (double Tokens, DateTime At)> _budgets = new();
        private readonly Func<DateTime> _now;

        /// <summary>Creates a budget.</summary>
        /// <param name="burst">Tokens a viewer starts with (and holds at most).</param>
        /// <param name="perSecond">Tokens a viewer gets back per second.</param>
        /// <param name="now">Clock.</param>
        internal ViewerBudget(int burst, double perSecond, Func<DateTime> now)
        {
            Burst = burst;
            PerSecond = perSecond;
            _now = now;
        }

        /// <summary>Tokens a viewer starts with (and holds at most).</summary>
        internal int Burst { get; }

        /// <summary>Tokens a viewer gets back per second.</summary>
        internal double PerSecond { get; }

        /// <summary>Takes one token from the viewer's budget.</summary>
        /// <param name="viewer">The viewer.</param>
        /// <returns>True when the work may start.</returns>
        internal bool Take(Guid viewer)
        {
            var now = _now();
            if (_budgets.Count > 10000) _budgets.Clear();
            var taken = false;
            _budgets.AddOrUpdate(
                viewer,
                _ =>
                {
                    taken = true;
                    return (Burst - 1, now);
                },
                (_, b) =>
                {
                    var tokens = Math.Min(Burst, b.Tokens + Math.Max(0, (now - b.At).TotalSeconds) * PerSecond);
                    taken = tokens >= 1;
                    return (taken ? tokens - 1 : tokens, now);
                });
            return taken;
        }

        /// <summary>Gives back a token taken for work that didn't start after all.</summary>
        /// <param name="viewer">The viewer.</param>
        internal void Refund(Guid viewer)
            => _budgets.AddOrUpdate(viewer, _ => (Burst, _now()), (_, b) => (Math.Min(Burst, b.Tokens + 1), b.At));
    }
}
