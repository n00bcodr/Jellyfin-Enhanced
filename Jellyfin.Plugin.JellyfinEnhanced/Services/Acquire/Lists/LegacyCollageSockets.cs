using System;
using System.Buffers;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The WebSocket side of <see cref="LegacyCollageProjection"/>. On both Jellyfin versions every WebSocket message the
    /// server sends (each listener's: sessions, activity, scheduled tasks; and each session controller's: playback,
    /// SyncPlay, library and user-data changes, and whatever a plugin sends a session) is serialized by the host's one
    /// <c>WebSocketConnection</c> onto the socket its <c>WebSocketManager</c> accepted. JE decorates that manager so the
    /// socket it accepts is a projecting one: each text message is projected before it leaves, and one that can't be
    /// checked is not sent.
    /// </summary>
    internal static class LegacyCollageSockets
    {
        /// <summary>Wraps the host's <see cref="IWebSocketManager"/> registration (the host registers its services before
        /// the plugins'). Returns false when there is none to wrap.</summary>
        /// <param name="services">The service collection the host and the plugins register into.</param>
        /// <returns>Whether the manager was wrapped.</returns>
        public static bool Decorate(IServiceCollection services)
        {
            var index = -1;
            for (var i = 0; i < services.Count; i++)
            {
                if (services[i].ServiceType == typeof(IWebSocketManager) && !services[i].IsKeyedService)
                {
                    index = i;
                }
            }

            if (index < 0)
            {
                return false;
            }

            var inner = services[index];
            services[index] = ServiceDescriptor.Describe(
                typeof(IWebSocketManager),
                provider => new Manager(Create(provider, inner), provider.GetRequiredService<LegacyCollageWithhold>(), provider.GetRequiredService<Logger>()),
                inner.Lifetime);
            return true;
        }

        private static IWebSocketManager Create(IServiceProvider provider, ServiceDescriptor descriptor)
            => (IWebSocketManager)(descriptor.ImplementationInstance
                ?? descriptor.ImplementationFactory?.Invoke(provider)
                ?? ActivatorUtilities.CreateInstance(provider, descriptor.ImplementationType!));

        /// <summary>The host's manager, handed a request whose WebSocket feature accepts projecting sockets.</summary>
        internal sealed class Manager : IWebSocketManager
        {
            private readonly IWebSocketManager _inner;
            private readonly LegacyCollageWithhold _withhold;
            private readonly Logger _logger;

            public Manager(IWebSocketManager inner, LegacyCollageWithhold withhold, Logger logger)
            {
                _inner = inner;
                _withhold = withhold;
                _logger = logger;
            }

            /// <inheritdoc />
            public Task WebSocketRequestHandler(HttpContext context)
            {
                if (context.Features.Get<IHttpWebSocketFeature>() is { } feature and not Feature)
                {
                    context.Features.Set<IHttpWebSocketFeature>(new Feature(feature, _withhold, _logger));
                }

                return _inner.WebSocketRequestHandler(context);
            }
        }

        private sealed class Feature : IHttpWebSocketFeature
        {
            private readonly IHttpWebSocketFeature _inner;
            private readonly LegacyCollageWithhold _withhold;
            private readonly Logger _logger;

            public Feature(IHttpWebSocketFeature inner, LegacyCollageWithhold withhold, Logger logger)
            {
                _inner = inner;
                _withhold = withhold;
                _logger = logger;
            }

            public bool IsWebSocketRequest => _inner.IsWebSocketRequest;

            public async Task<WebSocket> AcceptAsync(WebSocketAcceptContext context)
                => new ProjectingSocket(await _inner.AcceptAsync(context).ConfigureAwait(false), _withhold, _logger);
        }

        /// <summary>A socket whose text messages pass the projection on their way out; everything else is the accepted socket's.</summary>
        internal sealed class ProjectingSocket : WebSocket
        {
            // Largest message held while its fragments arrive (the host sends whole messages; this is a bound, not a size).
            private const int MaxMessageBytes = 16 * 1024 * 1024;

            private readonly WebSocket _inner;
            private readonly LegacyCollageWithhold _withhold;
            private readonly Logger _logger;
            private ArrayBufferWriter<byte>? _pending;
            private bool _warned;

            public ProjectingSocket(WebSocket inner, LegacyCollageWithhold withhold, Logger logger)
            {
                _inner = inner;
                _withhold = withhold;
                _logger = logger;
            }

            public override WebSocketCloseStatus? CloseStatus => _inner.CloseStatus;

            public override string? CloseStatusDescription => _inner.CloseStatusDescription;

            public override WebSocketState State => _inner.State;

            public override string? SubProtocol => _inner.SubProtocol;

            public override void Abort() => _inner.Abort();

            public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
                => _inner.CloseAsync(closeStatus, statusDescription, cancellationToken);

            public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
                => _inner.CloseOutputAsync(closeStatus, statusDescription, cancellationToken);

            public override void Dispose() => _inner.Dispose();

            public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
                => _inner.ReceiveAsync(buffer, cancellationToken);

            public override ValueTask<ValueWebSocketReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken cancellationToken)
                => _inner.ReceiveAsync(buffer, cancellationToken);

            public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
                => Send(buffer, messageType, endOfMessage ? WebSocketMessageFlags.EndOfMessage : WebSocketMessageFlags.None, cancellationToken).AsTask();

            public override ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
                => Send(buffer, messageType, endOfMessage ? WebSocketMessageFlags.EndOfMessage : WebSocketMessageFlags.None, cancellationToken);

            public override ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, WebSocketMessageFlags messageFlags, CancellationToken cancellationToken)
                => Send(buffer, messageType, messageFlags, cancellationToken);

            private ValueTask Send(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, WebSocketMessageFlags flags, CancellationToken cancellationToken)
            {
                if (messageType != WebSocketMessageType.Text)
                {
                    return _inner.SendAsync(buffer, messageType, flags, cancellationToken);
                }

                var end = (flags & WebSocketMessageFlags.EndOfMessage) != 0;
                if (!end || _pending != null)
                {
                    _pending ??= new ArrayBufferWriter<byte>();
                    if (_pending.WrittenCount + buffer.Length > MaxMessageBytes)
                    {
                        _pending = null;
                        Warn("a message too large to check");
                        return ValueTask.CompletedTask;
                    }

                    _pending.Write(buffer.Span);
                    if (!end)
                    {
                        return ValueTask.CompletedTask;
                    }

                    buffer = _pending.WrittenMemory;
                    _pending = null;
                }

                byte[]? projected;
                try
                {
                    var view = _withhold.Begin();
                    projected = view.Idle ? null : LegacyCollageProjection.ProjectMessage(buffer.Span, view);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // Fail closed: a message that couldn't be checked is not sent.
                    Warn(ex.GetType().Name + ": " + ex.Message);
                    return ValueTask.CompletedTask;
                }

                return _inner.SendAsync(projected ?? buffer, WebSocketMessageType.Text, flags | WebSocketMessageFlags.EndOfMessage, cancellationToken);
            }

            private void Warn(string why)
            {
                if (!_warned)
                {
                    _warned = true;
                    _logger.Warning($"[Lists] A WebSocket message couldn't be checked for legacy list collages ({why}); it was not sent.");
                }
            }
        }
    }
}
