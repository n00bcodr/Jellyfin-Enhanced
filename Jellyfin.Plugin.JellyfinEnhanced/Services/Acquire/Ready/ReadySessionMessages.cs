using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>One Jellyfin session as the native Ready message reads it (a copy, taken at once).</summary>
    public sealed record ReadySessionSnapshot
    {
        /// <summary>Session id.</summary>
        public string Id { get; init; } = string.Empty;

        /// <summary>The user signed in on it (empty: nobody).</summary>
        public Guid UserId { get; init; }

        /// <summary>Other users attached to it (a shared session).</summary>
        public int AdditionalUsers { get; init; }

        /// <summary>The client said it shows DisplayMessage (its SupportedCommands).</summary>
        public bool SupportsDisplayMessage { get; init; }

        /// <summary>A controller (WebSocket or HTTP) that can carry a command right now.</summary>
        public bool ActiveTransport { get; init; }

        /// <summary>Something is playing (a now-playing item).</summary>
        public bool Playing { get; init; }

        /// <summary>Playback is paused.</summary>
        public bool Paused { get; init; }

        /// <summary>The session has a playback state at all (no state is unknown, never idle).</summary>
        public bool PlayStateKnown { get; init; }

        /// <summary>Last activity (UTC).</summary>
        public DateTime LastActivity { get; init; }

        /// <summary>When the last playback event of the session was seen (start, progress, stop), or null.</summary>
        public DateTime? LastPlaybackEvent { get; init; }
    }

    /// <summary>What the classifier makes of one session for one recipient.</summary>
    public enum ReadySessionVerdict
    {
        /// <summary>Idle, supported and the recipient's own.</summary>
        Eligible,

        /// <summary>Another person's session (or nobody's).</summary>
        WrongUser,

        /// <summary>The recipient's, with other users attached.</summary>
        Shared,

        /// <summary>The client doesn't show DisplayMessage.</summary>
        Unsupported,

        /// <summary>No transport that could carry it now.</summary>
        NoTransport,

        /// <summary>Playing.</summary>
        Playing,

        /// <summary>Paused.</summary>
        Paused,

        /// <summary>Playback state unknown or just changed (between items).</summary>
        Unknown,

        /// <summary>Not active for a while.</summary>
        Stale,
    }

    /// <summary>Jellyfin's sessions as the native Ready message uses them (tests fake it).</summary>
    public interface IReadySessionHost
    {
        /// <summary>Every session now (copies).</summary>
        IReadOnlyList<ReadySessionSnapshot> Sessions();

        /// <summary>The session with this id now (a copy), or null when it is gone.</summary>
        ReadySessionSnapshot? Session(string id);

        /// <summary>Sends a DisplayMessage command to one session (completes when Jellyfin handed it to its transport).</summary>
        Task SendAsync(string sessionId, string header, string text, long timeoutMs, CancellationToken cancellationToken);
    }

    /// <summary>What happened to one native message.</summary>
    /// <param name="Accepted">Jellyfin accepted the command (never proof that a client showed it).</param>
    /// <param name="Unknown">The send started and its outcome is unknown (never sent again).</param>
    /// <param name="Reason">Why it wasn't sent (a terminal suppression), or null.</param>
    /// <param name="Session">A hash of the session it went to (never the session id itself), or null.</param>
    public sealed record ReadySendResult(bool Accepted, bool Unknown, string? Reason, string? Session);

    /// <summary>
    /// The native Ready message: one Jellyfin DisplayMessage command to ONE session that belongs to the recipient alone
    /// (its own signed-in user, no other users attached), says it shows DisplayMessage, has a live transport, and is idle:
    /// nothing playing or paused, a known playback state, no playback event in the last minute, active lately. If any of the
    /// recipient's sessions is playing or paused, they are busy and nothing is sent (suppressed, never queued). The session
    /// is read again immediately before the send. Jellyfin's own send checks none of this, so every check is here. A tiny
    /// race with a playback that starts in between remains; that's why the message is opt-in.
    /// </summary>
    public sealed class ReadySessionMessages
    {
        /// <summary>How long the client shows the message.</summary>
        public const long DisplayTimeoutMs = 15000;

        /// <summary>A playback event this recent makes the state unknown (an autoplay between items).</summary>
        internal static readonly TimeSpan PlaybackSettle = TimeSpan.FromSeconds(60);

        /// <summary>A session not active for this long is stale.</summary>
        internal static readonly TimeSpan ActiveWithin = TimeSpan.FromMinutes(15);

        private readonly IReadySessionHost _host;
        private readonly Func<DateTime> _now;

        /// <summary>Creates the sender.</summary>
        public ReadySessionMessages(IReadySessionHost host, Func<DateTime>? now = null)
        {
            _host = host;
            _now = now ?? (() => DateTime.UtcNow);
        }

        /// <summary>Classifies one session for a recipient.</summary>
        public static ReadySessionVerdict Classify(ReadySessionSnapshot s, Guid recipient, DateTime now)
        {
            if (s.UserId == Guid.Empty || s.UserId != recipient) return ReadySessionVerdict.WrongUser;
            if (s.AdditionalUsers > 0) return ReadySessionVerdict.Shared;
            if (s.Playing) return ReadySessionVerdict.Playing;
            if (s.Paused) return ReadySessionVerdict.Paused;
            if (!s.SupportsDisplayMessage) return ReadySessionVerdict.Unsupported;
            if (!s.ActiveTransport) return ReadySessionVerdict.NoTransport;
            if (!s.PlayStateKnown || (s.LastPlaybackEvent is DateTime p && now - p < PlaybackSettle)) return ReadySessionVerdict.Unknown;
            if (now - s.LastActivity > ActiveWithin) return ReadySessionVerdict.Stale;
            return ReadySessionVerdict.Eligible;
        }

        /// <summary>
        /// The session to send to now, or why there is none: the recipient's eligible session most recently active (the
        /// lowest id on a tie); none while any of their sessions is playing or paused.
        /// </summary>
        public (ReadySessionSnapshot? Session, string? Reason) Pick(Guid recipient)
        {
            var now = _now();
            var own = _host.Sessions().Where(s => s.UserId == recipient && recipient != Guid.Empty).ToList();
            if (own.Count == 0) return (null, "no_session");
            var verdicts = own.Select(s => (Session: s, Verdict: Classify(s, recipient, now))).ToList();
            if (verdicts.Any(v => v.Verdict is ReadySessionVerdict.Playing or ReadySessionVerdict.Paused)) return (null, "busy");
            var eligible = verdicts.Where(v => v.Verdict == ReadySessionVerdict.Eligible).Select(v => v.Session)
                .OrderByDescending(s => s.LastActivity).ThenBy(s => s.Id, StringComparer.Ordinal).FirstOrDefault();
            if (eligible != null) return (eligible, null);
            var reason = verdicts.Select(v => v.Verdict).OrderBy(v => v).First() switch
            {
                ReadySessionVerdict.Unknown => "unknown_state",
                ReadySessionVerdict.Unsupported => "unsupported",
                ReadySessionVerdict.Shared => "shared_session",
                ReadySessionVerdict.NoTransport => "no_transport",
                ReadySessionVerdict.Stale => "stale_session",
                _ => "no_session",
            };
            return (null, reason);
        }

        /// <summary>
        /// Sends one message to <paramref name="session"/> after reading it again (still the recipient's, idle and supported,
        /// and none of their sessions busy). <paramref name="claim"/> runs right before the send, with no await before it:
        /// it checks everything else once more, claims the deliveries and returns the header and text to show (rendered then),
        /// or null to send nothing.
        /// </summary>
        public async Task<ReadySendResult> SendAsync(Guid recipient, ReadySessionSnapshot session, Func<string, (string Header, string Text)?> claim, CancellationToken cancellationToken)
        {
            var hash = Hash(session.Id);
            var again = _host.Session(session.Id);
            if (again == null) return new ReadySendResult(false, false, "session_gone", hash);
            var verdict = Classify(again, recipient, _now());
            if (verdict != ReadySessionVerdict.Eligible) return new ReadySendResult(false, false, "changed_" + verdict.ToString().ToLowerInvariant(), hash);
            if (_host.Sessions().Any(s => s.UserId == recipient && (s.Playing || s.Paused))) return new ReadySendResult(false, false, "busy", hash);
            if (claim(hash) is not { } shown) return new ReadySendResult(false, false, "not_claimed", hash);
            try
            {
                await _host.SendAsync(again.Id, shown.Header, shown.Text, DisplayTimeoutMs, cancellationToken).ConfigureAwait(false);
                return new ReadySendResult(true, false, null, hash);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // The command may have reached the client: never sent again.
                return new ReadySendResult(false, true, "send_" + ex.GetType().Name, hash);
            }
        }

        /// <summary>A short hash of a session id (stored instead of the id).</summary>
        internal static string Hash(string sessionId) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sessionId)), 0, 8).ToLowerInvariant();
    }

    /// <summary>
    /// The production <see cref="IReadySessionHost"/> over Jellyfin's session manager. Playback events only record when they
    /// were seen for the session (an O(1), bounded write on the event thread, never a lock held over Jellyfin).
    /// </summary>
    public sealed class JellyfinReadySessionHost : IReadySessionHost, IDisposable
    {
        private const int MaxTracked = 1024;

        private readonly ISessionManager _sessions;
        private readonly ConcurrentDictionary<string, DateTime> _playback = new(StringComparer.Ordinal);

        /// <summary>Creates the host and listens to playback events (DI).</summary>
        public JellyfinReadySessionHost(ISessionManager sessions)
        {
            _sessions = sessions;
            _sessions.PlaybackStart += OnPlayback;
            _sessions.PlaybackProgress += OnPlayback;
            _sessions.PlaybackStopped += OnStopped;
            _sessions.SessionEnded += OnEnded;
        }

        /// <inheritdoc />
        public IReadOnlyList<ReadySessionSnapshot> Sessions() => _sessions.Sessions.Select(Snapshot).ToList();

        /// <inheritdoc />
        public ReadySessionSnapshot? Session(string id) => _sessions.Sessions.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.Ordinal)) is { } s ? Snapshot(s) : null;

        /// <inheritdoc />
        public Task SendAsync(string sessionId, string header, string text, long timeoutMs, CancellationToken cancellationToken)
            // An empty controlling session skips Jellyfin's remote-control check: JE checked the recipient itself.
            => _sessions.SendMessageCommand(string.Empty, sessionId, new MessageCommand { Header = header, Text = text, TimeoutMs = timeoutMs }, cancellationToken);

        /// <inheritdoc />
        public void Dispose()
        {
            _sessions.PlaybackStart -= OnPlayback;
            _sessions.PlaybackProgress -= OnPlayback;
            _sessions.PlaybackStopped -= OnStopped;
            _sessions.SessionEnded -= OnEnded;
        }

        private ReadySessionSnapshot Snapshot(SessionInfo s)
        {
            var controllers = s.SessionControllers ?? Array.Empty<ISessionController>();
            return new ReadySessionSnapshot
            {
                Id = s.Id ?? string.Empty,
                UserId = s.UserId,
                AdditionalUsers = s.AdditionalUsers?.Count ?? 0,
                SupportsDisplayMessage = s.SupportedCommands?.Contains(GeneralCommandType.DisplayMessage) == true,
                ActiveTransport = controllers.Any(c => c.IsSessionActive),
                Playing = s.NowPlayingItem != null || s.FullNowPlayingItem != null,
                Paused = s.PlayState?.IsPaused == true,
                PlayStateKnown = s.PlayState != null,
                LastActivity = DateTime.SpecifyKind(s.LastActivityDate, DateTimeKind.Utc),
                LastPlaybackEvent = s.Id != null && _playback.TryGetValue(s.Id, out var at) ? at : null,
            };
        }

        private void OnPlayback(object? sender, PlaybackProgressEventArgs e) => Note(e?.Session?.Id);

        private void OnStopped(object? sender, PlaybackStopEventArgs e) => Note(e?.Session?.Id);

        private void OnEnded(object? sender, SessionEventArgs e)
        {
            if (e?.SessionInfo?.Id is { } id) _playback.TryRemove(id, out _);
        }

        private void Note(string? sessionId)
        {
            if (string.IsNullOrEmpty(sessionId)) return;
            if (_playback.Count >= MaxTracked)
            {
                var cutoff = DateTime.UtcNow - TimeSpan.FromMinutes(10);
                foreach (var old in _playback.Where(p => p.Value < cutoff).Select(p => p.Key).ToList()) _playback.TryRemove(old, out _);
                if (_playback.Count >= MaxTracked) return;
            }

            _playback[sessionId] = DateTime.UtcNow;
        }
    }
}
