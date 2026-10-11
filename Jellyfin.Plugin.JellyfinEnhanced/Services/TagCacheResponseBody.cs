using System;
using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The body of a GET tag-cache response (see GetTagCache in the controller),
    /// assembled from three segments — the small leading properties, the
    /// serialized <c>items</c> object and the trailing <c>reviewRatings</c> — so
    /// that a shared <c>items</c> copy (TagCacheService.TryGetSerializedItems)
    /// is written straight to the response without being copied into a
    /// per-request buffer, and so that the ETag hashes the bytes actually sent.
    /// Byte-for-byte what MVC's JSON formatter produced for the equivalent
    /// anonymous object: the leading properties are written by a Utf8JsonWriter
    /// with the same encoder, the two embedded objects by the serializer with
    /// the same options, and a null <c>reviewRatings</c> is omitted (or written)
    /// exactly as the options' null handling did.
    /// </summary>
    public sealed class TagCacheResponseBody
    {
        private const string ContentType = "application/json; charset=utf-8";
        private static readonly byte[] ReviewRatingsProperty = Encoding.UTF8.GetBytes(",\"reviewRatings\":");
        private static readonly byte[] ClosingBrace = { (byte)'}' };
        private static readonly byte[] NullReviewRatingsSuffix = Encoding.UTF8.GetBytes(",\"reviewRatings\":null}");

        private readonly byte[] _prefix;
        private readonly byte[] _items;
        private readonly byte[] _suffix;

        private TagCacheResponseBody(byte[] prefix, byte[] items, byte[] suffix, string etag)
        {
            _prefix = prefix;
            _items = items;
            _suffix = suffix;
            ETag = etag;
        }

        /// <summary>
        /// Quoted SHA-256 of the body with its <c>servedAt</c> property removed,
        /// i.e. of the same JSON as the body minus the one property that changes
        /// on every request and would otherwise defeat revalidation of an
        /// unchanged body (a 304 hands back the stored body with its own,
        /// earlier servedAt — the same data, captured then). Two users at the
        /// same cache version can legitimately receive different stripped or
        /// filtered bodies, so it is a hash of the final bytes, never of the
        /// version alone.
        /// </summary>
        public string ETag { get; }

        public long Length => (long)_prefix.Length + _items.Length + _suffix.Length;

        /// <summary>
        /// Assemble the body <c>{"version":…,"timestamp":…,"servedAt":…,"filterRevision":"…","count":…,"items":…,"reviewRatings":…}</c>
        /// from the already serialized <paramref name="itemsJson"/> and
        /// <paramref name="reviewRatingsJson"/> (null when the chips are off,
        /// which omits the property) and compute its ETag in the same pass.
        /// </summary>
        public static TagCacheResponseBody Compose(
            JsonSerializerOptions options,
            long version,
            long timestamp,
            long servedAt,
            string filterRevision,
            int count,
            byte[] itemsJson,
            byte[]? reviewRatingsJson)
        {
            var prefix = new ArrayBufferWriter<byte>(256);
            int servedAtStart;
            int servedAtEnd;
            // The serializer writes with the options' encoder and no indentation
            // (and skips validation, as it does internally); mirror that so the
            // numbers and the one string come out identical.
            using (var writer = new Utf8JsonWriter(prefix, new JsonWriterOptions { Encoder = options.Encoder, Indented = false, SkipValidation = true }))
            {
                writer.WriteStartObject();
                writer.WriteNumber("version", version);
                writer.WriteNumber("timestamp", timestamp);
                writer.Flush();
                servedAtStart = prefix.WrittenCount;
                // Written as its own segment [servedAtStart, servedAtEnd), which
                // holds exactly `,"servedAt":N`, so the hash can skip it.
                writer.WriteNumber("servedAt", servedAt);
                writer.Flush();
                servedAtEnd = prefix.WrittenCount;
                writer.WriteString("filterRevision", filterRevision);
                writer.WriteNumber("count", count);
                writer.WritePropertyName("items");
                writer.Flush();
            }

            byte[] suffix;
            if (reviewRatingsJson == null)
            {
                // A null property is omitted or written exactly as the serializer
                // would under these options (Jellyfin's omit it).
                var omitNull = options.DefaultIgnoreCondition is System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
                    or System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault;
                suffix = omitNull ? ClosingBrace : NullReviewRatingsSuffix;
            }
            else
            {
                suffix = new byte[ReviewRatingsProperty.Length + reviewRatingsJson.Length + ClosingBrace.Length];
                ReviewRatingsProperty.CopyTo(suffix, 0);
                reviewRatingsJson.CopyTo(suffix, ReviewRatingsProperty.Length);
                ClosingBrace.CopyTo(suffix, ReviewRatingsProperty.Length + reviewRatingsJson.Length);
            }

            var prefixBytes = prefix.WrittenSpan;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(prefixBytes[..servedAtStart]);
            hash.AppendData(prefixBytes[servedAtEnd..]);
            hash.AppendData(itemsJson);
            hash.AppendData(suffix);
            var etag = "\"" + Convert.ToHexString(hash.GetHashAndReset()) + "\"";

            return new TagCacheResponseBody(prefixBytes.ToArray(), itemsJson, suffix, etag);
        }

        /// <summary>
        /// Copy of the complete body (tests and diagnostics; the response writes
        /// the segments directly).
        /// </summary>
        public byte[] ToArray()
        {
            var body = new byte[Length];
            _prefix.CopyTo(body, 0);
            _items.CopyTo(body, _prefix.Length);
            _suffix.CopyTo(body, _prefix.Length + _items.Length);
            return body;
        }

        /// <summary>A 200 result that writes the three segments to the response.</summary>
        public IActionResult ToActionResult() => new SegmentedResult(this);

        private sealed class SegmentedResult : IActionResult
        {
            private readonly TagCacheResponseBody _body;

            public SegmentedResult(TagCacheResponseBody body) => _body = body;

            public async Task ExecuteResultAsync(ActionContext context)
            {
                var response = context.HttpContext.Response;
                var aborted = context.HttpContext.RequestAborted;
                response.StatusCode = 200;
                response.ContentType = ContentType;
                response.ContentLength = _body.Length;
                await response.Body.WriteAsync(_body._prefix, aborted).ConfigureAwait(false);
                await response.Body.WriteAsync(_body._items, aborted).ConfigureAwait(false);
                await response.Body.WriteAsync(_body._suffix, aborted).ConfigureAwait(false);
            }
        }
    }
}
