using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
{
    /// <summary>
    /// Feeds Jellyfin's playback events into <see cref="ListPlaceholderAutoRequestService"/>. Always registered; the
    /// service checks the settings on every event, so turning list auto-requests on or off needs no restart. The work
    /// runs in the background: Jellyfin awaits event consumers inside the playback report.
    /// </summary>
    internal static class ListPlaceholderPlaybackEvents
    {
        /// <summary>Hands one event to the service (cheap when the feature is off).</summary>
        /// <param name="service">The auto-request service.</param>
        /// <param name="phase">Event kind.</param>
        /// <param name="eventArgs">Jellyfin's event.</param>
        public static void Forward(ListPlaceholderAutoRequestService service, PlaybackPhase phase, PlaybackProgressEventArgs? eventArgs)
        {
            if (eventArgs?.Item == null || eventArgs.Session == null || !ListPlaceholderAutoRequestService.IsEnabled())
            {
                return;
            }

            var session = eventArgs.Session;
            var sessionKey = !string.IsNullOrEmpty(session.Id) ? session.Id : eventArgs.DeviceId;
            _ = service.OnPlayback(phase, session.UserId, sessionKey, PlayedItem.From(eventArgs.Item), eventArgs.PlaybackPositionTicks);
        }
    }

    /// <summary>Playback start → list auto-request trigger (minutes = 0, or a resume past the threshold).</summary>
    public sealed class ListPlaceholderPlaybackStartConsumer : IEventConsumer<PlaybackStartEventArgs>
    {
        private readonly ListPlaceholderAutoRequestService _service;

        /// <summary>Creates the consumer.</summary>
        /// <param name="service">The auto-request service.</param>
        public ListPlaceholderPlaybackStartConsumer(ListPlaceholderAutoRequestService service) => _service = service;

        /// <inheritdoc />
        public Task OnEvent(PlaybackStartEventArgs eventArgs)
        {
            ListPlaceholderPlaybackEvents.Forward(_service, PlaybackPhase.Start, eventArgs);
            return Task.CompletedTask;
        }
    }

    /// <summary>Playback progress → list auto-request trigger once the position reaches the configured minutes.</summary>
    public sealed class ListPlaceholderPlaybackProgressConsumer : IEventConsumer<PlaybackProgressEventArgs>
    {
        private readonly ListPlaceholderAutoRequestService _service;

        /// <summary>Creates the consumer.</summary>
        /// <param name="service">The auto-request service.</param>
        public ListPlaceholderPlaybackProgressConsumer(ListPlaceholderAutoRequestService service) => _service = service;

        /// <inheritdoc />
        public Task OnEvent(PlaybackProgressEventArgs eventArgs)
        {
            ListPlaceholderPlaybackEvents.Forward(_service, PlaybackPhase.Progress, eventArgs);
            return Task.CompletedTask;
        }
    }

    /// <summary>Playback stop past the configured minutes → list auto-request trigger (if progress never reported it).</summary>
    public sealed class ListPlaceholderPlaybackStopConsumer : IEventConsumer<PlaybackStopEventArgs>
    {
        private readonly ListPlaceholderAutoRequestService _service;

        /// <summary>Creates the consumer.</summary>
        /// <param name="service">The auto-request service.</param>
        public ListPlaceholderPlaybackStopConsumer(ListPlaceholderAutoRequestService service) => _service = service;

        /// <inheritdoc />
        public Task OnEvent(PlaybackStopEventArgs eventArgs)
        {
            ListPlaceholderPlaybackEvents.Forward(_service, PlaybackPhase.Stop, eventArgs);
            return Task.CompletedTask;
        }
    }
}
