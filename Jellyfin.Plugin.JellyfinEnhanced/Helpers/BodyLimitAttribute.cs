using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Caps a route's request body before model binding and refuses a larger one with a structured
    /// 413 (<c>{ error, code: "payload_too_large", message, limitBytes }</c>). Kestrel's own limit
    /// (<c>[RequestSizeLimit]</c>) can't be used for this: its 413 is an exception that Jellyfin's
    /// exception middleware turns into a 500. A declared <c>Content-Length</c> over the cap is refused
    /// without reading anything; a body without one (chunked) is read up to the cap and refused at the
    /// first byte past it. The bytes read are handed to model binding unchanged.
    /// </summary>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
    public sealed class BodyLimitAttribute : Attribute, IAsyncResourceFilter, IOrderedFilter
    {
        /// <summary>The cap for most routes: 16 KiB.</summary>
        public const int DefaultBytes = 16 * 1024;

        /// <summary>The 413 code.</summary>
        public const string Code = "payload_too_large";

        /// <summary>Caps the body at <paramref name="bytes"/> (default <see cref="DefaultBytes"/>).</summary>
        public BodyLimitAttribute(int bytes = DefaultBytes)
        {
            if (bytes <= 0) throw new ArgumentOutOfRangeException(nameof(bytes));
            Bytes = bytes;
        }

        /// <summary>The largest body accepted, in bytes.</summary>
        public int Bytes { get; }

        /// <summary>Runs before other resource filters (and so before model binding).</summary>
        public int Order => int.MinValue + 100;

        /// <summary>The structured 413 for a body over <paramref name="limitBytes"/>.</summary>
        public static ObjectResult TooLarge(int limitBytes)
            => new(new { error = true, code = Code, message = $"The request body is larger than {limitBytes} bytes.", limitBytes })
            {
                StatusCode = StatusCodes.Status413PayloadTooLarge,
            };

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            var request = context.HttpContext.Request;
            if (request.ContentLength is long declared && declared > Bytes)
            {
                context.Result = TooLarge(Bytes);
                return;
            }
            if (request.ContentLength != 0)
            {
                byte[]? body;
                try
                {
                    body = await ReadCappedAsync(request.Body, Bytes, context.HttpContext.RequestAborted).ConfigureAwait(false);
                }
                catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
                {
                    // The server's own (larger) limit: still the structured answer, never a 500.
                    body = null;
                }
                if (body == null)
                {
                    context.Result = TooLarge(Bytes);
                    return;
                }
                request.Body = new MemoryStream(body, writable: false);
                request.ContentLength = body.Length;
            }
            await next().ConfigureAwait(false);
        }

        /// <summary>The whole body when it is at most <paramref name="cap"/> bytes, else null (reading stops at the first byte past it).</summary>
        internal static async Task<byte[]?> ReadCappedAsync(Stream body, int cap, CancellationToken cancellationToken)
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[Math.Min(cap + 1, 16 * 1024)];
            int n;
            while ((n = await body.ReadAsync(chunk.AsMemory(0, (int)Math.Min(chunk.Length, cap + 1 - buffer.Length)), cancellationToken).ConfigureAwait(false)) > 0)
            {
                buffer.Write(chunk, 0, n);
                if (buffer.Length > cap) return null;
            }
            return buffer.ToArray();
        }
    }
}
