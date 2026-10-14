using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// What the outbox tells the rest of the plugin after a commit: a job whose write was confirmed
    /// upstream (for example, the Seerr scan nudge after Jellyfin Enhanced added a title in JE mode).
    /// Subscribers run on the outbox worker and must return quickly; their exceptions are swallowed.
    /// </summary>
    public sealed class RequestOutboxEvents
    {
        /// <summary>A job's upstream write was confirmed and committed.</summary>
        public event Action<RequestJob>? Confirmed;

        /// <summary>Raises <see cref="Confirmed"/>; a failing subscriber never affects the outbox.</summary>
        internal void RaiseConfirmed(RequestJob job)
        {
            foreach (var handler in Confirmed?.GetInvocationList() ?? Array.Empty<Delegate>())
            {
                try
                {
                    ((Action<RequestJob>)handler)(job);
                }
                catch (Exception)
                {
                    // A subscriber's failure is its own; the job is already committed.
                }
            }
        }
    }
}
