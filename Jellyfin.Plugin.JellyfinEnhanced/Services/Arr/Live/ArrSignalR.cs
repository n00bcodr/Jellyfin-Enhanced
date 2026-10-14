using System;
using System.Buffers;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>One <c>receiveMessage</c> from an arr: which resource, what happened, and the resource if sent.</summary>
    /// <param name="Name">Resource name (<c>queue</c>, <c>movie</c>, <c>episodefile</c>, ...).</param>
    /// <param name="Action">updated, deleted, sync or created.</param>
    /// <param name="Resource">The resource (a clone; undefined when the message had none).</param>
    public sealed record ArrHubMessage(string Name, string Action, JsonElement Resource)
    {
        /// <summary>True when a resource object came with the message.</summary>
        public bool HasResource => Resource.ValueKind == JsonValueKind.Object;
    }

    /// <summary>
    /// The small part of the SignalR JSON hub protocol an arr speaks to its own web UI: a handshake,
    /// then server-to-client <c>receiveMessage</c> invocations, pings and a close message. JE never
    /// invokes anything. Records end with the 0x1E record separator.
    /// </summary>
    public static class ArrHubProtocol
    {
        /// <summary>The record separator.</summary>
        public const char RecordSeparator = '\u001e';

        /// <summary>Message type of an invocation.</summary>
        public const int InvocationType = 1;

        /// <summary>Message type of a ping.</summary>
        public const int PingType = 6;

        /// <summary>Message type of a close.</summary>
        public const int CloseType = 7;

        /// <summary>The handshake request (JSON protocol, version 1).</summary>
        public static readonly byte[] Handshake = Encoding.UTF8.GetBytes("{\"protocol\":\"json\",\"version\":1}" + RecordSeparator);

        /// <summary>A ping record.</summary>
        public static readonly byte[] Ping = Encoding.UTF8.GetBytes("{\"type\":6}" + RecordSeparator);

        /// <summary>
        /// Takes every complete record out of <paramref name="buffer"/> (text received so far) and
        /// leaves an incomplete tail in it.
        /// </summary>
        public static List<string> TakeRecords(StringBuilder buffer)
        {
            var records = new List<string>();
            var text = buffer.ToString();
            var start = 0;
            int end;
            while ((end = text.IndexOf(RecordSeparator, start)) >= 0)
            {
                if (end > start) records.Add(text.Substring(start, end - start));
                start = end + 1;
            }
            buffer.Clear();
            if (start < text.Length) buffer.Append(text, start, text.Length - start);
            return records;
        }

        /// <summary>
        /// Reads one record. Returns its type (0 for the handshake reply), the message for a
        /// <c>receiveMessage</c> invocation, and the error text of a handshake reply or close.
        /// Malformed records come back as type -1.
        /// </summary>
        public static (int Type, ArrHubMessage? Message, string? Error) Parse(string record)
        {
            try
            {
                using var doc = JsonDocument.Parse(record, new JsonDocumentOptions { MaxDepth = 64 });
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return (-1, null, null);
                var error = root.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
                if (!root.TryGetProperty("type", out var t)) return (0, null, error);
                if (t.ValueKind != JsonValueKind.Number || !t.TryGetInt32(out var type)) return (-1, null, error);
                if (type != InvocationType) return (type, null, error);
                if (!root.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.String
                    || !string.Equals(target.GetString(), "receiveMessage", StringComparison.OrdinalIgnoreCase))
                    return (type, null, null);
                if (!root.TryGetProperty("arguments", out var args) || args.ValueKind != JsonValueKind.Array || args.GetArrayLength() == 0) return (type, null, null);
                var arg = args[0];
                if (arg.ValueKind != JsonValueKind.Object) return (type, null, null);
                var name = arg.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? string.Empty : string.Empty;
                var action = string.Empty;
                JsonElement resource = default;
                if (arg.TryGetProperty("body", out var body) && body.ValueKind == JsonValueKind.Object)
                {
                    if (body.TryGetProperty("action", out var a) && a.ValueKind == JsonValueKind.String) action = a.GetString() ?? string.Empty;
                    if (body.TryGetProperty("resource", out var r) && r.ValueKind == JsonValueKind.Object) resource = r.Clone();
                    else if (name == "version") resource = body.Clone();
                }
                return (type, new ArrHubMessage(name, action, resource), null);
            }
            catch (JsonException)
            {
                return (-1, null, null);
            }
        }
    }

    /// <summary>Opens the WebSocket to an arr's hub (tests swap it for an in-memory socket).</summary>
    /// <param name="uri">ws(s)://host[:port][/urlBase]/signalr/messages (never carries the key).</param>
    /// <param name="apiKey">The instance's API key, sent as the <c>X-Api-Key</c> header.</param>
    /// <param name="cancellationToken">Stops the attempt.</param>
    public delegate Task<WebSocket> ArrSocketConnector(Uri uri, string apiKey, CancellationToken cancellationToken);

    /// <summary>A connection attempt that failed for a reason worth telling the admin (no URL or key in it).</summary>
    public sealed class ArrLiveConnectException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public ArrLiveConnectException(string message, Exception? inner = null)
            : base(message, inner)
        {
        }
    }

    /// <summary>State of an instance's live connection.</summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ArrLiveState
    {
        /// <summary>Not running (live updates off, or phase 1 off).</summary>
        Off,
        /// <summary>Opening the connection.</summary>
        Connecting,
        /// <summary>Connected and receiving.</summary>
        Connected,
        /// <summary>Waiting before the next attempt (backoff).</summary>
        Waiting,
    }

    /// <summary>Admin view of one live connection. Never carries the URL or key.</summary>
    public sealed class ArrLiveConnectionStatus
    {
        /// <summary>Current state.</summary>
        [JsonPropertyName("state")]
        public ArrLiveState State { get; init; }

        /// <summary>Since when.</summary>
        [JsonPropertyName("since")]
        public DateTimeOffset? Since { get; init; }

        /// <summary>Last message (or ping) from the arr.</summary>
        [JsonPropertyName("lastMessageAt")]
        public DateTimeOffset? LastMessageAt { get; init; }

        /// <summary>Messages received since start.</summary>
        [JsonPropertyName("messages")]
        public long Messages { get; init; }

        /// <summary>Successful connects after the first.</summary>
        [JsonPropertyName("reconnects")]
        public long Reconnects { get; init; }

        /// <summary>Failed attempts in a row.</summary>
        [JsonPropertyName("failuresInARow")]
        public int FailuresInARow { get; init; }

        /// <summary>The reason the last attempt failed or the connection dropped.</summary>
        [JsonPropertyName("lastError")]
        public string? LastError { get; init; }

        /// <summary>When the next attempt is due (while waiting).</summary>
        [JsonPropertyName("nextAttemptAt")]
        public DateTimeOffset? NextAttemptAt { get; init; }

        /// <summary>The arr's version as its hub reported it.</summary>
        [JsonPropertyName("version")]
        public string? Version { get; init; }
    }

    /// <summary>Timings of a live connection (tests shorten them).</summary>
    public sealed record ArrLiveTiming(TimeSpan FirstBackoff, TimeSpan MaxBackoff, TimeSpan PingInterval, TimeSpan Silence, TimeSpan Handshake)
    {
        /// <summary>Production timings: backoff 2 s to 2 min, ping every 15 s, dead after 60 s of silence.</summary>
        public static readonly ArrLiveTiming Default = new(TimeSpan.FromSeconds(2), TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(10));

        /// <summary>
        /// Least time between two library re-reads after reconnects of one instance. A reconnect
        /// sooner than that gets its library re-read when the gap is over (never skipped), so a
        /// flapping connection costs at most one library read per gap.
        /// </summary>
        public TimeSpan LibraryResyncGap { get; init; } = TimeSpan.FromMinutes(1);
    }

    /// <summary>
    /// One outbound connection to an arr's SignalR hub (<c>/signalr/messages</c>) for one instance:
    /// handshake, a read loop that hands every <c>receiveMessage</c> to <c>onMessage</c>, pings,
    /// a silence timeout, and reconnects with jittered exponential backoff (2 s → 2 min). Every
    /// successful connect calls <c>onConnected</c> (the arrs don't replay what was missed, so the
    /// caller re-reads). The API key travels only in the <c>X-Api-Key</c> header and is never logged.
    /// </summary>
    public sealed class ArrSignalRConnection : IDisposable
    {
        private const int MaxRecordBytes = 8 * 1024 * 1024;

        private readonly ArrConnection _connection;
        private readonly string _apiKey;
        private readonly ArrSocketConnector _connector;
        private readonly Action<ArrConnection, ArrHubMessage> _onMessage;
        private readonly Action<ArrConnection, bool, TimeSpan> _onConnected;
        private readonly Logger? _logger;
        private readonly ArrLiveTiming _timing;
        private readonly Func<DateTimeOffset> _now;
        private readonly object _lock = new();
        private CancellationTokenSource? _stop;
        private Task? _loop;
        private ArrLiveState _state = ArrLiveState.Off;
        private DateTimeOffset? _since;
        private DateTimeOffset? _lastMessageAt;
        private long _messages;
        private long _connects;
        private int _failures;
        private string? _lastError;
        private DateTimeOffset? _nextAttemptAt;
        private string? _version;
        private DateTimeOffset? _lostAt;

        /// <summary>Creates the connection (not started).</summary>
        public ArrSignalRConnection(
            ArrConnection connection,
            string apiKey,
            string fingerprint,
            ArrSocketConnector connector,
            Action<ArrConnection, ArrHubMessage> onMessage,
            Action<ArrConnection, bool, TimeSpan> onConnected,
            Logger? logger,
            ArrLiveTiming? timing = null,
            Func<DateTimeOffset>? now = null)
        {
            _connection = connection;
            _apiKey = apiKey;
            Fingerprint = fingerprint;
            _connector = connector;
            _onMessage = onMessage;
            _onConnected = onConnected;
            _logger = logger;
            _timing = timing ?? ArrLiveTiming.Default;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>URL, kind and a hash of the key: a change means a new connection.</summary>
        public string Fingerprint { get; }

        /// <summary>The instance.</summary>
        public ArrConnection Connection => _connection;

        /// <summary>The hub address for an instance URL (http → ws, https → wss), or null when the URL is not usable.</summary>
        public static Uri? HubUri(string? baseUrl)
        {
            var trimmed = (baseUrl ?? string.Empty).Trim().TrimEnd('/');
            if (!ArrUrlGuard.PassesStaticChecks(trimmed) || !Uri.TryCreate(trimmed + "/signalr/messages", UriKind.Absolute, out var http)) return null;
            var builder = new UriBuilder(http) { Scheme = http.Scheme == Uri.UriSchemeHttps ? "wss" : "ws", Query = string.Empty, Fragment = string.Empty };
            if (http.IsDefaultPort) builder.Port = -1;
            return builder.Uri;
        }

        /// <summary>A snapshot of the state for the admin view.</summary>
        public ArrLiveConnectionStatus Status()
        {
            lock (_lock)
            {
                return new ArrLiveConnectionStatus
                {
                    State = _state,
                    Since = _since,
                    LastMessageAt = _lastMessageAt,
                    Messages = _messages,
                    Reconnects = Math.Max(0, _connects - 1),
                    FailuresInARow = _failures,
                    LastError = _lastError,
                    NextAttemptAt = _state == ArrLiveState.Waiting ? _nextAttemptAt : null,
                    Version = _version,
                };
            }
        }

        /// <summary>Starts the connect/read/reconnect loop.</summary>
        public void Start()
        {
            lock (_lock)
            {
                if (_loop != null) return;
                _stop = new CancellationTokenSource();
                var token = _stop.Token;
                using (ExecutionContext.SuppressFlow())
                {
                    _loop = Task.Run(() => RunAsync(token), CancellationToken.None);
                }
            }
        }

        /// <summary>Closes the connection and stops reconnecting.</summary>
        public async Task StopAsync()
        {
            Task? loop;
            lock (_lock)
            {
                loop = _loop;
                _loop = null;
                try
                {
                    _stop?.Cancel();
                }
                catch (ObjectDisposedException)
                {
                    // already stopped
                }
            }
            if (loop != null)
            {
                try
                {
                    await loop.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // stopping
                }
            }
            lock (_lock)
            {
                _state = ArrLiveState.Off;
                _since = _now();
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            try
            {
                _stop?.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // already disposed
            }
            _stop?.Dispose();
        }

        private void Set(ArrLiveState state, string? error = null)
        {
            lock (_lock)
            {
                if (_state != state) _since = _now();
                _state = state;
                if (error != null) _lastError = error;
            }
        }

        private async Task RunAsync(CancellationToken stop)
        {
            while (!stop.IsCancellationRequested)
            {
                string? failure = null;
                var connected = false;
                try
                {
                    connected = await ConnectAndReadAsync(stop).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested)
                {
                    break;
                }
                catch (ArrLiveConnectException ex)
                {
                    failure = ex.Message;
                }
                catch (WebSocketException)
                {
                    failure = "The connection dropped.";
                }
                catch (OperationCanceledException)
                {
                    failure = "The instance stopped answering.";
                }
                catch (Exception ex) when (ex is HttpRequestException or System.IO.IOException)
                {
                    failure = "Could not connect. Check the URL and that the app is running.";
                }
                catch (Exception ex)
                {
                    failure = "Live updates hit an error (" + ex.GetType().Name + ").";
                }

                if (stop.IsCancellationRequested) break;
                int failures;
                lock (_lock)
                {
                    _lostAt ??= _now();
                    if (connected) _failures = 0;
                    if (failure != null) _failures++;
                    failures = _failures;
                }
                if (failure != null && failures == 1)
                {
                    _logger?.Warning($"Arr live: {_connection.Name} live updates unavailable ({failure.TrimEnd('.')}); retrying with backoff, webhooks and polling still apply.");
                }

                var wait = Backoff(Math.Max(1, failures));
                lock (_lock) _nextAttemptAt = _now() + wait;
                Set(ArrLiveState.Waiting, failure ?? "The connection closed.");
                try
                {
                    await Task.Delay(wait, stop).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        private TimeSpan Backoff(int attempt)
        {
            var baseTicks = Math.Min(_timing.MaxBackoff.Ticks, _timing.FirstBackoff.Ticks * (1L << Math.Min(attempt - 1, 16)));
            var jitter = 0.8 + (Random.Shared.NextDouble() * 0.4);
            return TimeSpan.FromTicks((long)(baseTicks * jitter));
        }

        // True when the handshake completed (the connection was up) before it ended.
        private async Task<bool> ConnectAndReadAsync(CancellationToken stop)
        {
            Set(ArrLiveState.Connecting);
            var uri = HubUri(_connection.Url) ?? throw new ArrLiveConnectException("The instance URL is not an allowed http(s) address.");
            using var attempt = CancellationTokenSource.CreateLinkedTokenSource(stop);
            attempt.CancelAfter(_timing.Handshake);
            using var socket = await _connector(uri, _apiKey, attempt.Token).ConfigureAwait(false);
            await socket.SendAsync(ArrHubProtocol.Handshake, WebSocketMessageType.Text, true, attempt.Token).ConfigureAwait(false);

            var buffer = new StringBuilder();
            var handshakeDone = false;
            var bytes = ArrayPool<byte>.Shared.Rent(16 * 1024);
            using var session = CancellationTokenSource.CreateLinkedTokenSource(stop);
            Task? pinger = null;
            try
            {
                var decoder = Encoding.UTF8.GetDecoder();
                var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
                while (true)
                {
                    using var silence = CancellationTokenSource.CreateLinkedTokenSource(handshakeDone ? session.Token : attempt.Token);
                    silence.CancelAfter(handshakeDone ? _timing.Silence : _timing.Handshake);
                    var result = await socket.ReceiveAsync(new ArraySegment<byte>(bytes), silence.Token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        if (!handshakeDone) throw new ArrLiveConnectException("The instance closed the connection during the handshake.");
                        return true;
                    }
                    var n = decoder.GetChars(bytes, 0, result.Count, chars, 0, false);
                    buffer.Append(chars, 0, n);
                    if (buffer.Length > MaxRecordBytes) throw new ArrLiveConnectException("A live message from the instance was too large.");
                    lock (_lock) _lastMessageAt = _now();

                    foreach (var record in ArrHubProtocol.TakeRecords(buffer))
                    {
                        var (type, message, error) = ArrHubProtocol.Parse(record);
                        if (!handshakeDone)
                        {
                            if (type != 0 || error != null) throw new ArrLiveConnectException("The instance refused the live-updates handshake.");
                            handshakeDone = true;
                            OnConnected();
                            pinger = PingLoopAsync(socket, session.Token);
                            continue;
                        }
                        if (type == ArrHubProtocol.CloseType) return true;
                        if (message == null) continue;
                        lock (_lock)
                        {
                            _messages++;
                            if (message.Name == "version" && message.Resource.ValueKind == JsonValueKind.Object
                                && message.Resource.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String)
                                _version = v.GetString();
                        }
                        try
                        {
                            _onMessage(_connection, message);
                        }
                        catch (Exception ex)
                        {
                            _logger?.Warning($"Arr live: {_connection.Name} message \"{message.Name}\" could not be handled ({ex.GetType().Name}).");
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (!stop.IsCancellationRequested && !handshakeDone)
            {
                throw new ArrLiveConnectException("The instance did not complete the live-updates handshake in time.");
            }
            finally
            {
                session.Cancel();
                ArrayPool<byte>.Shared.Return(bytes);
                if (pinger != null)
                {
                    try
                    {
                        await pinger.ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        // the session is over
                    }
                }
                if (socket.State == WebSocketState.Open)
                {
                    try
                    {
                        using var close = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, string.Empty, close.Token).ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        // best effort
                    }
                }
            }
        }

        private void OnConnected()
        {
            bool first;
            TimeSpan down;
            lock (_lock)
            {
                first = _connects == 0;
                _connects++;
                down = _lostAt is { } lost ? _now() - lost : TimeSpan.Zero;
                _lostAt = null;
                _failures = 0;
                _lastError = null;
            }
            Set(ArrLiveState.Connected);
            if (!first) _logger?.Info($"Arr live: {_connection.Name} live updates connected again.");
            try
            {
                _onConnected(_connection, first, down);
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Arr live: {_connection.Name} resync after connecting failed ({ex.GetType().Name}).");
            }
        }

        private async Task PingLoopAsync(WebSocket socket, CancellationToken session)
        {
            while (!session.IsCancellationRequested)
            {
                await Task.Delay(_timing.PingInterval, session).ConfigureAwait(false);
                await socket.SendAsync(ArrHubProtocol.Ping, WebSocketMessageType.Text, true, session).ConfigureAwait(false);
            }
        }

        /// <summary>
        /// The production connector: a <see cref="ClientWebSocket"/> over the guarded arr transport
        /// (no redirects, no proxy, connect-time address check), key in the <c>X-Api-Key</c> header.
        /// </summary>
        public static ArrSocketConnector CreateConnector(HttpMessageInvoker invoker)
            => async (uri, apiKey, cancellationToken) =>
            {
                var socket = new ClientWebSocket();
                socket.Options.SetRequestHeader("X-Api-Key", apiKey);
                socket.Options.SetRequestHeader("User-Agent", "JellyfinEnhanced");
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
                socket.Options.CollectHttpResponseDetails = true;
                try
                {
                    await socket.ConnectAsync(uri, invoker, cancellationToken).ConfigureAwait(false);
                    return socket;
                }
                catch (WebSocketException ex)
                {
                    var status = (int)socket.HttpStatusCode;
                    socket.Dispose();
                    if (IsBlocked(ex)) throw new ArrLiveConnectException("The instance's address is not allowed (cloud metadata or link-local range).");
                    throw new ArrLiveConnectException(status switch
                    {
                        401 or 403 => "The API key was rejected.",
                        >= 300 and < 400 => "The instance answered with a redirect, which is not followed. Use its direct address, including any URL base.",
                        404 => "The instance has no live-updates endpoint at this address (check the URL base).",
                        > 0 => $"The instance refused live updates (HTTP {status}).",
                        _ => "Could not connect. Check the URL and that the app is running.",
                    });
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            };

        private static bool IsBlocked(Exception ex)
        {
            for (var e = ex; e != null; e = e.InnerException)
            {
                if (e is ArrBlockedAddressException) return true;
            }
            return false;
        }
    }
}
