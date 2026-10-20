using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The dashboard's live session updates ("SessionsStart" / "Sessions" over the WebSocket), as Jellyfin's own
/// SessionInfoWebSocketListener sends them on 12.2 and 10.11.11 (the same sessions, events and per-connection filter),
/// with each update projected for the connection's viewer like the REST answer: an administrator sees every account's
/// sessions, and a title that viewer hid or guards is projected out of them (sessions and their controls stay).
/// Registered in place of the native listener; with no privacy policy for the viewer the update is unchanged.
/// </summary>
public sealed class PrivacySessionsWebSocketListener : BasePeriodicWebSocketListener<IEnumerable<SessionInfoDto>, WebSocketListenerState>
{
    /// <summary>The native listener this one replaces.</summary>
    public const string NativeTypeName = "Jellyfin.Api.WebSocketListeners.SessionInfoWebSocketListener";

#if JF12
    private static SessionInfoDto ToDto(ISessionManager sessions, SessionInfo session) => sessions.ToSessionInfoDto(session);

    /// <summary>Whether the host can build session DTOs for this listener (always on Jellyfin 12).</summary>
    public static bool Supported => true;
#else
    // 10.11.0's package has no ISessionManager.ToSessionInfoDto (later 10.11 hosts, 10.11.11 included, do and use it in
    // their own listener): bound once from the host at run time; without it the native listener is left in place.
    private static readonly System.Reflection.MethodInfo? _toDto = typeof(ISessionManager).GetMethod("ToSessionInfoDto", new[] { typeof(SessionInfo) });

    private static SessionInfoDto ToDto(ISessionManager sessions, SessionInfo session) => (SessionInfoDto)_toDto!.Invoke(sessions, new object[] { session })!;

    /// <summary>Whether the host can build session DTOs for this listener (10.11 hosts that have ToSessionInfoDto).</summary>
    public static bool Supported => _toDto != null && _toDto.ReturnType == typeof(SessionInfoDto);
#endif

    private readonly ISessionManager _sessions;
    private readonly TitlePresentationResultFilter _gate;
    private bool _disposed;

    /// <summary>Initializes a new instance of the <see cref="PrivacySessionsWebSocketListener"/> class.</summary>
    /// <param name="logger">The logger.</param>
    /// <param name="sessions">The session manager.</param>
    /// <param name="gate">The final presentation gate (its session projection).</param>
    public PrivacySessionsWebSocketListener(ILogger<PrivacySessionsWebSocketListener> logger, ISessionManager sessions, TitlePresentationResultFilter gate)
        : base(logger)
    {
        _sessions = sessions;
        _gate = gate;
        _sessions.SessionStarted += OnSessionStarted;
        _sessions.SessionEnded += OnSessionEnded;
        _sessions.PlaybackStart += OnPlaybackStart;
        _sessions.PlaybackStopped += OnPlaybackStopped;
        _sessions.PlaybackProgress += OnPlaybackProgress;
        _sessions.CapabilitiesChanged += OnCapabilitiesChanged;
        _sessions.SessionActivity += OnSessionActivity;
    }

    /// <inheritdoc />
    protected override SessionMessageType Type => SessionMessageType.Sessions;

    /// <inheritdoc />
    protected override SessionMessageType StartType => SessionMessageType.SessionsStart;

    /// <inheritdoc />
    protected override SessionMessageType StopType => SessionMessageType.SessionsStop;

    /// <inheritdoc />
    protected override Task<IEnumerable<SessionInfoDto>> GetDataToSend()
        => Task.FromResult<IEnumerable<SessionInfoDto>>(_sessions.Sessions.Select(s => ToDto(_sessions, s)).ToList());

    /// <inheritdoc />
    protected override Task<IEnumerable<SessionInfoDto>> GetDataToSendForConnection(IWebSocketConnection connection)
    {
        IEnumerable<SessionInfo> source = _sessions.Sessions;
        var user = connection.AuthorizationInfo?.User;
        // The native filter: a non-administrator sees only the sessions they are (or share) a user of.
        if (user != null && connection.AuthorizationInfo?.IsApiKey != true && !user.HasPermission(PermissionKind.IsAdministrator))
        {
            var id = user.Id;
            source = source.Where(s => s.UserId.Equals(id) || s.ContainsUser(id));
        }
        var dtos = source.Select(s => ToDto(_sessions, s)).ToList();
        // An API key has no viewer: nothing to project for (as the REST answer).
        return Task.FromResult<IEnumerable<SessionInfoDto>>(user == null ? dtos : _gate.ProjectSessions(dtos, user.Id));
    }

    /// <inheritdoc />
    protected override void Start(WebSocketMessageInfo message)
    {
        if (message.Connection.AuthorizationInfo.User == null && !message.Connection.AuthorizationInfo.IsApiKey)
        {
            throw new MediaBrowser.Controller.Authentication.AuthenticationException("User must be authenticated to subscribe to session Information.");
        }
        base.Start(message);
    }

    /// <inheritdoc />
    protected override async ValueTask DisposeAsyncCore()
    {
        if (!_disposed)
        {
            _sessions.SessionStarted -= OnSessionStarted;
            _sessions.SessionEnded -= OnSessionEnded;
            _sessions.PlaybackStart -= OnPlaybackStart;
            _sessions.PlaybackStopped -= OnPlaybackStopped;
            _sessions.PlaybackProgress -= OnPlaybackProgress;
            _sessions.CapabilitiesChanged -= OnCapabilitiesChanged;
            _sessions.SessionActivity -= OnSessionActivity;
            _disposed = true;
        }
        await base.DisposeAsyncCore().ConfigureAwait(false);
    }

    private void OnSessionActivity(object? sender, SessionEventArgs e) => SendData(false);

    private void OnCapabilitiesChanged(object? sender, SessionEventArgs e) => SendData(true);

    private void OnPlaybackProgress(object? sender, MediaBrowser.Controller.Library.PlaybackProgressEventArgs e) => SendData(!e.IsAutomated);

    private void OnPlaybackStopped(object? sender, MediaBrowser.Controller.Library.PlaybackStopEventArgs e) => SendData(true);

    private void OnPlaybackStart(object? sender, MediaBrowser.Controller.Library.PlaybackProgressEventArgs e) => SendData(true);

    private void OnSessionEnded(object? sender, SessionEventArgs e) => SendData(true);

    private void OnSessionStarted(object? sender, SessionEventArgs e) => SendData(true);
}
