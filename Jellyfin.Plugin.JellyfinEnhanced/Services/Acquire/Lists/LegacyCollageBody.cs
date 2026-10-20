using System;
using System.Buffers;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The MVC side of <see cref="LegacyCollageProjection"/>, at the serialization boundary: whatever result type an action
    /// (or a filter) answers with (an object, <c>JsonResult</c>, <c>ContentResult</c>, a JSON file or stream, a streamed
    /// sequence, a result type nobody has written yet), its body is written through a response body JE holds while any
    /// legacy collage marker or tile record exists. A JSON body (or a text body that is JSON) is projected before it
    /// leaves; any other body (images, scripts, pages) passes straight through, unheld. A JSON body that can't be checked,
    /// or is too large to hold, is not sent (500).
    /// </summary>
    public sealed class LegacyCollageBody : IAsyncResourceFilter
    {
        /// <summary>Filter order: outside every other filter, so its body is the last thing written.</summary>
        public const int Order = int.MinValue + 100;

        /// <summary>Largest JSON body held for checking.</summary>
        internal const int MaxHeldBytes = 128 * 1024 * 1024;

        private readonly LegacyCollageWithhold _withhold;
        private readonly Logger _logger;

        /// <summary>Creates the filter (DI).</summary>
        /// <param name="withhold">The owner of the legacy collage verdicts.</param>
        /// <param name="logger">JE logger.</param>
        public LegacyCollageBody(LegacyCollageWithhold withhold, Logger logger)
        {
            _withhold = withhold;
            _logger = logger;
        }

        /// <summary>How a body with this content type is treated.</summary>
        internal enum Handling
        {
            /// <summary>Not JSON (an image, a script, a page): written straight through.</summary>
            Pass,

            /// <summary>Declared JSON: held and projected; one that isn't JSON is not sent.</summary>
            Json,

            /// <summary>Plain text or no type: held, projected if it is JSON, else sent as it was.</summary>
            Text,
        }

        /// <summary>The handling of a response content type.</summary>
        /// <param name="contentType">The response's content type, if any.</param>
        /// <returns>The handling.</returns>
        internal static Handling HandlingOf(string? contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType))
            {
                return Handling.Text;
            }

            if (!MediaTypeHeaderValue.TryParse(contentType, out var media) || media.MediaType.Value is not { } type)
            {
                // Can't be told apart: held, and projected if it is JSON.
                return Handling.Text;
            }

            if (type.Equals("application/json", StringComparison.OrdinalIgnoreCase) || type.Equals("text/json", StringComparison.OrdinalIgnoreCase)
                || type.EndsWith("+json", StringComparison.OrdinalIgnoreCase) || type.EndsWith("/x-json", StringComparison.OrdinalIgnoreCase))
            {
                return Handling.Json;
            }

            return type.Equals("text/plain", StringComparison.OrdinalIgnoreCase) || type.Equals("*/*", StringComparison.Ordinal) ? Handling.Text : Handling.Pass;
        }

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            var view = _withhold.Begin();
            if (view.Idle)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var http = context.HttpContext;
            var prior = http.Features.Get<IHttpResponseBodyFeature>();
            if (prior == null)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var held = new HeldBody(http, prior);
            var feature = new StreamResponseBodyFeature(held, prior);
            http.Features.Set<IHttpResponseBodyFeature>(feature);
            try
            {
                await next().ConfigureAwait(false);
                // Whatever is still in the pipe writer reaches the held body.
                await feature.CompleteAsync().ConfigureAwait(false);
            }
            finally
            {
                http.Features.Set(prior);
            }

            if (held.Mode != HeldBody.Held)
            {
                return;
            }

            await WriteHeld(http, prior, held, view).ConfigureAwait(false);
        }

        private async Task WriteHeld(HttpContext http, IHttpResponseBodyFeature prior, HeldBody held, LegacyCollageView view)
        {
            var response = http.Response;
            if (held.Overflowed)
            {
                Fail(response, "a JSON answer too large to check");
                return;
            }

            ReadOnlyMemory<byte> body = held.Bytes;
            byte[]? projected;
            LegacyCollageProjected outcome;
            try
            {
                outcome = LegacyCollageProjection.Project(body.Span, view, out projected);
            }
            catch (Exception ex)
            {
                Fail(response, ex.GetType().Name + ": " + ex.Message);
                return;
            }

            switch (outcome)
            {
                case LegacyCollageProjected.Changed:
                    body = projected;
                    if (response.ContentLength != null)
                    {
                        response.ContentLength = body.Length;
                    }

                    break;
                case LegacyCollageProjected.NotJson when held.Handling == Handling.Json && body.Length > 0:
                    Fail(response, "a JSON answer that isn't JSON");
                    return;
            }

            if (body.Length > 0)
            {
                await prior.Stream.WriteAsync(body, http.RequestAborted).ConfigureAwait(false);
            }
        }

        private void Fail(HttpResponse response, string why)
        {
            // Fail closed: an answer that couldn't be checked is not sent. Nothing of it has been written yet.
            _logger.Warning($"[Lists] Could not check an answer for legacy list collages ({why}); answered 500.");
            response.StatusCode = StatusCodes.Status500InternalServerError;
            response.ContentLength = 0;
        }

        /// <summary>
        /// The response body while an action runs: on its first write (or flush) it looks at the content type and either
        /// passes everything to the real body or holds it for the projection.
        /// </summary>
        internal sealed class HeldBody : Stream
        {
            public const int Undecided = 0;
            public const int Passing = 1;
            public const int Held = 2;

            private readonly HttpContext _http;
            private readonly IHttpResponseBodyFeature _prior;
            private readonly ArrayBufferWriter<byte> _buffer = new();

            public HeldBody(HttpContext http, IHttpResponseBodyFeature prior)
            {
                _http = http;
                _prior = prior;
            }

            public int Mode { get; private set; }

            public Handling Handling { get; private set; }

            public bool Overflowed { get; private set; }

            public ReadOnlyMemory<byte> Bytes => _buffer.WrittenMemory;

            public override bool CanRead => false;

            public override bool CanSeek => false;

            public override bool CanWrite => true;

            public override long Length => throw new NotSupportedException();

            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

            public override void Flush()
            {
                if (Decide() == Passing)
                {
                    _prior.Stream.Flush();
                }
            }

            public override Task FlushAsync(CancellationToken cancellationToken)
                => Decide() == Passing ? _prior.Stream.FlushAsync(cancellationToken) : Task.CompletedTask;

            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

            public override void Write(ReadOnlySpan<byte> buffer)
            {
                if (Decide() == Passing)
                {
                    _prior.Stream.Write(buffer);
                    return;
                }

                Hold(buffer);
            }

            public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
                => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

            public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            {
                if (Decide() == Passing)
                {
                    return _prior.Stream.WriteAsync(buffer, cancellationToken);
                }

                Hold(buffer.Span);
                return ValueTask.CompletedTask;
            }

            private void Hold(ReadOnlySpan<byte> buffer)
            {
                if (Overflowed)
                {
                    return;
                }

                if ((long)_buffer.WrittenCount + buffer.Length > MaxHeldBytes)
                {
                    Overflowed = true;
                    return;
                }

                _buffer.Write(buffer);
            }

            private int Decide()
            {
                if (Mode == Undecided)
                {
                    Handling = HandlingOf(_http.Response.ContentType);
                    Mode = Handling == Handling.Pass ? Passing : Held;
                }

                return Mode;
            }
        }
    }
}
