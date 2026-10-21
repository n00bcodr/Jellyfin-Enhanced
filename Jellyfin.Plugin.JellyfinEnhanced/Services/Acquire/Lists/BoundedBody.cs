using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// THE reader of every HTTP answer the lists subsystem and its provider metadata read (review round 11, 4c2-R11-3; D53
    /// "every HTTP read is bounded"): list sources (the fetcher's gate and its Seerr fallback), Seerr metadata and lookups,
    /// TMDB posters, TMDB lookups and JE-only metadata (TmdbResponseCache), MDBList ratings and account status. A request is
    /// sent with <see cref="SendAsync"/> (the answer comes back as soon as its headers are in, nothing of its body buffered),
    /// and its body, a success's or an error's alike, is read only by <see cref="ReadAsync"/>: streamed, at most
    /// <see cref="MaxBytes"/>. An announced or actual body over the cap is <see cref="ResponseTooLargeException"/>; nothing
    /// past the cap is read and nothing is cut silently. A body that isn't read at all (a status that decides on its own) is
    /// never buffered either.
    /// </summary>
    internal static class BoundedBody
    {
        /// <summary>The cap of every answer: 8 MiB (the largest real list page or record JE reads is well under 1 MiB).</summary>
        public const int MaxBytes = 8 * 1024 * 1024;

        private const int Chunk = 81920;

        /// <summary>Sends a request; the answer is returned when its headers are in (its body is read by <see cref="ReadAsync"/> only).</summary>
        /// <param name="client">The client.</param>
        /// <param name="request">The request.</param>
        /// <param name="cancellationToken">Stops the send (and, kept by the caller, the body read).</param>
        /// <returns>The answer, its body unread.</returns>
        public static Task<HttpResponseMessage> SendAsync(HttpClient client, HttpRequestMessage request, CancellationToken cancellationToken) =>
            client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

        /// <summary>Reads an answer's body (UTF-8), at most <see cref="MaxBytes"/>.</summary>
        /// <param name="response">The answer (sent by <see cref="SendAsync"/>).</param>
        /// <param name="cancellationToken">Stops the read (the caller's timeout covers the body too).</param>
        /// <returns>The body.</returns>
        /// <exception cref="ResponseTooLargeException">The body is announced or turns out to be over the cap.</exception>
        public static async Task<string> ReadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(response);
            if (response.Content.Headers.ContentLength > MaxBytes)
            {
                throw new ResponseTooLargeException();
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var buffer = new MemoryStream();
            var chunk = new byte[Chunk];
            int read;
            while ((read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > MaxBytes)
                {
                    throw new ResponseTooLargeException();
                }

                buffer.Write(chunk, 0, read);
            }

            var bytes = buffer.GetBuffer();
            var length = (int)buffer.Length;
            var bom = length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0; // a UTF-8 byte order mark
            return Encoding.UTF8.GetString(bytes, bom, length - bom);
        }
    }

    /// <summary>
    /// An answer over <see cref="BoundedBody.MaxBytes"/>. An <see cref="HttpRequestException"/>, as HttpClient's own buffer limit
    /// raised before, so every caller that handled that still does.
    /// </summary>
    public sealed class ResponseTooLargeException : HttpRequestException
    {
        /// <summary>Creates the exception.</summary>
        public ResponseTooLargeException()
            : base("The answer is larger than Jellyfin Enhanced reads.")
        {
        }
    }
}
