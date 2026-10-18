using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>
    /// The DisplayMessage channel of the durable notification dispatch (phase 4f): the recipient's Hidden Content check, the
    /// claim recorded before the send (a claim with no outcome is never sent again, after a restart either), one idle
    /// session picked and read again, and the outcome: Jellyfin accepted the command, or it is unknown. Whether a client
    /// showed it is never known (no client confirms it), so it is never claimed.
    /// </summary>
    public sealed class ReadyNativeChannel
    {
        /// <summary>A native message older than this is never shown (it was held while notifications were off).</summary>
        internal static readonly TimeSpan FreshFor = TimeSpan.FromMinutes(10);

        private readonly ReadyPlaylistStore _store;
        private readonly ReadySessionMessages _messages;
        private readonly IReadyPrivacy _privacy;
        private readonly IArrJellyfinView _view;
        private readonly TitleAliases? _aliases;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Creates the channel (DI).</summary>
        public ReadyNativeChannel(ReadyPlaylistStore store, ReadySessionMessages messages, IReadyPrivacy privacy, IArrJellyfinView view, TitleAliases aliases)
            : this(store, messages, privacy, view, aliases, null)
        {
        }

        /// <summary>Creates the channel with a clock (tests).</summary>
        internal ReadyNativeChannel(ReadyPlaylistStore store, ReadySessionMessages messages, IReadyPrivacy privacy, IArrJellyfinView view, TitleAliases? aliases, Func<DateTimeOffset>? now)
        {
            _store = store;
            _messages = messages;
            _privacy = privacy;
            _view = view;
            _aliases = aliases;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>True when the delivery already has an attempt (sent, unknown or claimed before a restart): never again.</summary>
        public bool Attempted(long deliveryId) => _store.AttemptState(deliveryId) != null;

        /// <summary>
        /// True when the recipient's Hidden Content hides the title or item (the library surface, as the Ready playlist), or
        /// their rules can't be read now (an on-screen message fails closed).
        /// </summary>
        public bool Hidden(Guid user, string? titleKey, string? itemId)
        {
            var hides = _privacy.Load(user);
            if (hides == null) return true;
            var keys = new List<TitleKey>();
            if (TitleKey.Parse(titleKey) is { } key)
            {
                keys.Add(key.Title);
                keys.AddRange(_aliases?.Of(key) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>());
            }

            var item = Guid.TryParse(itemId, out var id) ? id : Guid.Empty;
            Guid? series = null;
            if (item != Guid.Empty && _view.Viewer(user) is { } viewer) series = _view.Resolve(item, viewer)?.SeriesId;
            return hides.Hidden(keys, item, series);
        }

        /// <summary>
        /// Sends one message to the recipient's idle session. <paramref name="final"/> runs right before the send, with no
        /// await before it: it checks every delivery once more and renders the message from the settings as they are then
        /// (the deliveries still going and the message, or null to send nothing); those deliveries are claimed before the
        /// send. Returns what happened and which deliveries it was for; each claimed attempt row has its outcome.
        /// </summary>
        public async Task<(ReadySendResult Result, IReadOnlyList<long> Sent)> SendAsync(Guid user, long generation, Func<(NotifyMessage Message, IReadOnlyList<long> Ids)?> final, CancellationToken cancellationToken)
        {
            var (session, reason) = _messages.Pick(user);
            if (session == null) return (new ReadySendResult(false, false, reason, null), Array.Empty<long>());
            var claimed = new List<long>();
            var result = await _messages.SendAsync(user, session, hash =>
            {
                if (final() is not { } going || going.Ids.Count == 0) return null;
                foreach (var id in going.Ids)
                {
                    if (!_store.Claim(generation, id, user, hash, _now())) return null;
                    claimed.Add(id);
                }

                return (going.Message.Title, going.Message.Body);
            }, cancellationToken).ConfigureAwait(false);
            var state = result.Accepted ? "accepted" : result.Unknown ? "unknown" : "suppressed";
            foreach (var id in claimed) _store.Settle(generation, id, state, result.Reason, _now());
            return (result, claimed);
        }
    }
}
