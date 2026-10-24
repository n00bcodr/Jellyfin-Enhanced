using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>How long a call may take and how big its answer may be.</summary>
    public enum ArrCallClass
    {
        /// <summary>Status/health probes: 10 s, 1 MiB.</summary>
        Status,
        /// <summary>Single resources and small lists: 30 s, 16 MiB.</summary>
        Read,
        /// <summary>Whole-library lists (movies, series, paged history): 120 s, 256 MiB, streamed.</summary>
        List,
        /// <summary>POST/PUT/DELETE: 30 s, 16 MiB. Never retried automatically.</summary>
        Write,
    }

    /// <summary>
    /// Typed client for one Sonarr or Radarr instance (v3 API). One per instance, created by
    /// <see cref="ArrClientFactory"/>; thread-safe.
    /// <list type="bullet">
    /// <item><description>The key is sent only as an <c>X-Api-Key</c> header, never in a URL.</description></item>
    /// <item><description>No redirects are followed (reported as <see cref="ArrErrorKind.Redirect"/>).</description></item>
    /// <item><description>Timeouts and response-size caps per <see cref="ArrCallClass"/>; bodies are streamed into the parser.</description></item>
    /// <item><description>Errors are normalised to <see cref="ArrError"/>; the arr's stack-trace <c>description</c> is dropped.</description></item>
    /// <item><description>At most <see cref="MaxConcurrency"/> calls in flight per instance; idempotent GETs back off and
    /// retry on 429/502/503/504 and connection failures; writes are never retried.</description></item>
    /// <item><description>Caller cancellation is honoured and surfaces as <see cref="OperationCanceledException"/>.</description></item>
    /// </list>
    /// </summary>
    public sealed class ArrClient
    {
        /// <summary>Concurrent calls per instance.</summary>
        public const int MaxConcurrency = 4;

        private const int MaxGetAttempts = 3;
        private const int ErrorBodyLimit = 64 * 1024;
        private static readonly TimeSpan StatusCacheTtl = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromSeconds(10);

        internal static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNameCaseInsensitive = true,
            NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
        };

        // The arrs speak camelCase JSON.
        private static readonly JsonSerializerOptions WriteOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        private readonly Func<HttpClient> _http;
        private readonly string _apiKey;
        private readonly string _baseUrl;
        private readonly SemaphoreSlim _gate = new(MaxConcurrency, MaxConcurrency);
        private readonly Func<TimeSpan, CancellationToken, Task> _delay;
        private readonly object _statusLock = new();
        private (ArrSystemStatus Status, ArrCapabilities Capabilities, DateTimeOffset At)? _status;

        /// <summary>Creates a client. Use <see cref="ArrClientFactory"/> outside tests.</summary>
        /// <param name="connection">The instance (kind and URL are used).</param>
        /// <param name="apiKey">The real API key.</param>
        /// <param name="http">Supplies an HttpClient per call (a factory client in production).</param>
        /// <param name="delay">Backoff delay (tests replace it).</param>
        internal ArrClient(ArrConnection connection, string apiKey, Func<HttpClient> http, Func<TimeSpan, CancellationToken, Task>? delay = null)
        {
            Connection = connection;
            _apiKey = apiKey;
            _http = http;
            _baseUrl = (connection.Url ?? string.Empty).Trim().TrimEnd('/');
            _delay = delay ?? Task.Delay;
        }

        /// <summary>Replaces the per-class timeout and size cap (tests).</summary>
        internal Func<ArrCallClass, (TimeSpan Timeout, long Cap)>? BudgetOverride { get; set; }

        /// <summary>The instance this client talks to.</summary>
        public ArrConnection Connection { get; }

        /// <summary>
        /// The connection this client talks over (its kind, URL and a hash of its key), server-only and opaque: two clients of
        /// one instance with the same generation reach the same server with the same credential (see
        /// <see cref="ArrClientFactory.Bound(ArrClient, bool)"/>). Empty for a client of unsaved values.
        /// </summary>
        internal string Generation { get; init; } = string.Empty;

        /// <summary>Calls made since creation (diagnostics and the "zero upstream calls" checks).</summary>
        public long CallCount => Interlocked.Read(ref _callCount);

        private long _callCount;

        /// <summary>
        /// Reads <c>system/status</c> (cached for 10 minutes unless <paramref name="refresh"/>),
        /// verifies the <c>appName</c> matches the instance kind, and derives the capabilities.
        /// </summary>
        public async Task<ArrResult<(ArrSystemStatus Status, ArrCapabilities Capabilities)>> GetSystemStatusAsync(bool refresh = false, CancellationToken cancellationToken = default)
        {
            lock (_statusLock)
            {
                if (!refresh && _status is { } cached && DateTimeOffset.UtcNow - cached.At < StatusCacheTtl)
                {
                    return ArrResult<(ArrSystemStatus, ArrCapabilities)>.Success((cached.Status, cached.Capabilities));
                }
            }

            var result = await GetAsync<JsonElement>("system/status", null, ArrCallClass.Status, cancellationToken).ConfigureAwait(false);
            if (!result.Ok) return ArrResult<(ArrSystemStatus, ArrCapabilities)>.Failure(result.Error!);

            var status = ArrSystemStatus.Parse(result.Value);
            if (status == null)
            {
                return ArrResult<(ArrSystemStatus, ArrCapabilities)>.Failure(ArrErrorKind.WrongApp,
                    "The URL answered, but not with Sonarr/Radarr status information.");
            }
            if (!ArrCapabilities.IsExpectedApp(Connection.Kind, status.AppName))
            {
                var found = string.IsNullOrEmpty(status.AppName) ? "an unknown app" : status.AppName;
                return ArrResult<(ArrSystemStatus, ArrCapabilities)>.Failure(ArrErrorKind.WrongApp,
                    $"This URL is {found}, not {ArrCapabilities.AppNameFor(Connection.Kind)}.");
            }

            var capabilities = ArrCapabilities.For(Connection.Kind, status.Version);
            lock (_statusLock)
            {
                _status = (status, capabilities, DateTimeOffset.UtcNow);
            }
            return ArrResult<(ArrSystemStatus, ArrCapabilities)>.Success((status, capabilities));
        }

        /// <summary>GET a v3 resource (<paramref name="path"/> relative to <c>/api/v3/</c>, or absolute from the base URL when it starts with '/').</summary>
        public Task<ArrResult<T>> GetAsync<T>(string path, IEnumerable<KeyValuePair<string, string?>>? query = null, ArrCallClass callClass = ArrCallClass.Read, CancellationToken cancellationToken = default)
            => SendCoreAsync<T>(HttpMethod.Get, path, query, null, callClass, null, cancellationToken);

        /// <summary>POST/PUT/DELETE with an optional JSON body. Not retried.</summary>
        public Task<ArrResult<T>> SendAsync<T>(HttpMethod method, string path, object? body, IEnumerable<KeyValuePair<string, string?>>? query = null, CancellationToken cancellationToken = default)
            => SendCoreAsync<T>(method, path, query, body, ArrCallClass.Write, null, cancellationToken);

        /// <summary>
        /// A write like <see cref="SendAsync{T}"/> that asks <paramref name="proceed"/> once more right before it leaves,
        /// after waiting for a free connection slot (which can take a while when slow calls hold them all). False: nothing
        /// is sent and the call fails as not sent.
        /// </summary>
        internal Task<ArrResult<T>> SendCheckedAsync<T>(HttpMethod method, string path, object? body, Func<bool> proceed, CancellationToken cancellationToken)
            => SendCoreAsync<T>(method, path, null, body, ArrCallClass.Write, proceed, cancellationToken);

        /// <summary>
        /// Reads every record of a paged list (<c>{page, pageSize, totalRecords, records}</c>) with an
        /// explicit page size, following <c>totalRecords</c>, up to <paramref name="maxRecords"/>.
        /// With <paramref name="idOf"/>, rows are counted (and kept) once per id: the arrs page a
        /// list sorted by a value that changes while it is read (the queue by time left), so a row
        /// can show up on two pages while another moves past the page boundary unseen, and they
        /// answer a page past the end with an earlier page. Paging then stops at the first page that
        /// brings no new id; <see cref="ArrPagedList{T}.Short"/> tells the caller the read holds
        /// fewer distinct rows than the largest <c>totalRecords</c> any page reported. Equal counts
        /// do not prove completeness when more than one page was read.
        /// </summary>
        public async Task<ArrResult<ArrPagedList<T>>> GetAllPagesAsync<T>(string path, IEnumerable<KeyValuePair<string, string?>>? query = null, int pageSize = 250, int maxRecords = 50_000, CancellationToken cancellationToken = default, Func<T, int>? idOf = null)
        {
            pageSize = Math.Clamp(pageSize, 1, 1000);
            var records = new List<T>();
            var seen = idOf == null ? null : new HashSet<int>();
            var total = 0;
            var pages = 0;
            // Every page but the last adds at least one row, so the cap bounds the number of pages.
            for (var page = 1; ; page++)
            {
                var pageQuery = (query ?? Enumerable.Empty<KeyValuePair<string, string?>>())
                    .Where(q => q.Key != "page" && q.Key != "pageSize")
                    .Append(new KeyValuePair<string, string?>("page", page.ToString(CultureInfo.InvariantCulture)))
                    .Append(new KeyValuePair<string, string?>("pageSize", pageSize.ToString(CultureInfo.InvariantCulture)));
                var result = await GetAsync<ArrPage<T>>(path, pageQuery, ArrCallClass.List, cancellationToken).ConfigureAwait(false);
                if (!result.Ok) return ArrResult<ArrPagedList<T>>.Failure(result.Error!);

                pages++;
                var body = result.Value!;
                total = Math.Max(total, body.TotalRecords);
                var got = body.Records ?? new List<T>();
                var added = 0;
                foreach (var row in got)
                {
                    if (seen != null && !seen.Add(idOf!(row))) continue;
                    records.Add(row);
                    added++;
                }
                if (records.Count >= maxRecords)
                {
                    var truncated = records.Count > maxRecords || records.Count < total;
                    if (records.Count > maxRecords) records.RemoveRange(maxRecords, records.Count - maxRecords);
                    return ArrResult<ArrPagedList<T>>.Success(new ArrPagedList<T> { Records = records, TotalRecords = total, Pages = pages, Truncated = truncated });
                }
                if (added == 0 || records.Count >= total) break;
            }
            return ArrResult<ArrPagedList<T>>.Success(new ArrPagedList<T> { Records = records, TotalRecords = total, Pages = pages, Short = seen != null && records.Count < total });
        }

        /// <summary>Builds the absolute URL for a path and query (exposed for tests).</summary>
        internal string BuildUrl(string path, IEnumerable<KeyValuePair<string, string?>>? query)
        {
            var sb = new StringBuilder(_baseUrl);
            if (path.StartsWith('/')) sb.Append(path);
            else sb.Append("/api/v3/").Append(path);
            var first = !path.Contains('?');
            foreach (var (key, value) in query ?? Enumerable.Empty<KeyValuePair<string, string?>>())
            {
                if (value == null) continue;
                sb.Append(first ? '?' : '&').Append(Uri.EscapeDataString(key)).Append('=').Append(Uri.EscapeDataString(value));
                first = false;
            }
            return sb.ToString();
        }

        private async Task<ArrResult<T>> SendCoreAsync<T>(HttpMethod method, string path, IEnumerable<KeyValuePair<string, string?>>? query, object? body, ArrCallClass callClass, Func<bool>? proceed, CancellationToken cancellationToken)
        {
            if (string.IsNullOrEmpty(_apiKey))
                return ArrResult<T>.Failure(ArrErrorKind.NotConfigured, "No API key is stored for this instance.");
            if (!ArrUrlGuard.PassesStaticChecks(_baseUrl))
                return ArrResult<T>.Failure(ArrErrorKind.BlockedUrl, "The instance URL is not an allowed http(s) address.");

            var url = BuildUrl(path, query);
            var (timeout, cap) = BudgetOverride?.Invoke(callClass) ?? Budget(callClass);
            var idempotent = method == HttpMethod.Get;
            var bodyBytes = body == null ? null : JsonSerializer.SerializeToUtf8Bytes(body, body.GetType(), WriteOptions);

            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (proceed != null && !proceed())
                    return ArrResult<T>.Failure(ArrErrorKind.NotConfigured, "The write was stopped before it was sent.");
                for (var attempt = 1; ; attempt++)
                {
                    var outcome = await SendOnceAsync<T>(method, url, bodyBytes, timeout, cap, cancellationToken).ConfigureAwait(false);
                    if (outcome.Result.Ok || !idempotent || attempt >= MaxGetAttempts || !outcome.Retryable)
                    {
                        return outcome.Result;
                    }

                    var wait = outcome.Result.Error!.RetryAfter is { } ra && ra > TimeSpan.Zero
                        ? (ra < MaxRetryAfter ? ra : MaxRetryAfter)
                        : TimeSpan.FromMilliseconds(500 * Math.Pow(3, attempt - 1) + Random.Shared.Next(0, 250));
                    await _delay(wait, cancellationToken).ConfigureAwait(false);
                }
            }
            finally
            {
                _gate.Release();
            }
        }

        private async Task<(ArrResult<T> Result, bool Retryable)> SendOnceAsync<T>(HttpMethod method, string url, byte[]? body, TimeSpan timeout, long cap, CancellationToken cancellationToken)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(timeout);
            var token = timeoutCts.Token;
            Interlocked.Increment(ref _callCount);
            ArrCallCounter.Current.Value?.Increment();

            using var request = new HttpRequestMessage(method, url);
            request.Headers.TryAddWithoutValidation("X-Api-Key", _apiKey);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            request.Headers.UserAgent.ParseAdd("JellyfinEnhanced");
            if (body != null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
            }

            HttpResponseMessage? response = null;
            try
            {
                // The named client has an infinite HttpClient.Timeout; the per-class budget above applies.
                var client = _http();
                try
                {
                    response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
                }
                catch (HttpRequestException ex)
                {
                    return (ArrResult<T>.Failure(TransportError(ex, sent: false)), !IsBlocked(ex));
                }

                var status = (int)response.StatusCode;
                if (status >= 300 && status < 400)
                {
                    return (ArrResult<T>.Failure(ArrErrorKind.Redirect,
                        "The instance answered with a redirect, which Jellyfin Enhanced does not follow (the API key must not be sent elsewhere). Use the instance's direct address, including any URL base.", status), false);
                }
                if (!response.IsSuccessStatusCode)
                {
                    var error = await ReadErrorAsync(response, token).ConfigureAwait(false);
                    var retryable = status is 429 or 502 or 503 or 504;
                    return (ArrResult<T>.Failure(error), retryable);
                }

                var mediaType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
                if (mediaType.Contains("html", StringComparison.OrdinalIgnoreCase))
                {
                    return (ArrResult<T>.Failure(ArrErrorKind.InvalidResponse,
                        "The instance returned a web page instead of API data. This is usually a reverse-proxy login page: use the internal address.", status), false);
                }
                // From here the arr itself accepted the request (a web page above is a proxy answering
                // in its place): a reply JE can't use doesn't undo a write, so these errors are Accepted.
                if (response.Content.Headers.ContentLength is long length && length > cap)
                {
                    return (ArrResult<T>.Failure(Accepted(ArrErrorKind.TooLarge, $"The response is larger than the {cap / (1024 * 1024)} MiB limit.", status)), false);
                }

                if (typeof(T) == typeof(NoContent) || status == 204)
                {
                    return (ArrResult<T>.Success(default!), false);
                }

                await using var stream = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
                await using var capped = new CappedReadStream(stream, cap);
                try
                {
                    var value = await JsonSerializer.DeserializeAsync<T>(capped, JsonOptions, token).ConfigureAwait(false);
                    return value is null
                        ? (ArrResult<T>.Failure(Accepted(ArrErrorKind.InvalidResponse, "The instance returned an empty response.", status)), false)
                        : (ArrResult<T>.Success(value), false);
                }
                catch (JsonException)
                {
                    return (ArrResult<T>.Failure(Accepted(ArrErrorKind.InvalidResponse, "The instance returned data Jellyfin Enhanced could not read.", status)), false);
                }
                catch (CappedReadStream.LimitExceededException)
                {
                    return (ArrResult<T>.Failure(Accepted(ArrErrorKind.TooLarge, $"The response is larger than the {cap / (1024 * 1024)} MiB limit.", status)), false);
                }
                catch (HttpRequestException)
                {
                    return (ArrResult<T>.Failure(Accepted(ArrErrorKind.ConnectionLost, "The connection dropped while reading the response.", status)), false);
                }
                catch (IOException)
                {
                    return (ArrResult<T>.Failure(Accepted(ArrErrorKind.ConnectionLost, "The connection dropped while reading the response.", status)), false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                // Our own budget expired. For a write this is "maybe sent" (see ArrError.MaybeSent).
                return (ArrResult<T>.Failure(ArrErrorKind.Timeout, $"The instance did not answer within {timeout.TotalSeconds:0} seconds."), false);
            }
            finally
            {
                response?.Dispose();
            }
        }

        private static ArrError Accepted(ArrErrorKind kind, string message, int status) => new(kind, message, status) { Accepted = true };

        private static (TimeSpan Timeout, long Cap) Budget(ArrCallClass callClass) => callClass switch
        {
            ArrCallClass.Status => (TimeSpan.FromSeconds(10), 1L * 1024 * 1024),
            ArrCallClass.List => (TimeSpan.FromSeconds(120), 256L * 1024 * 1024),
            ArrCallClass.Write => (TimeSpan.FromSeconds(30), 16L * 1024 * 1024),
            _ => (TimeSpan.FromSeconds(30), 16L * 1024 * 1024),
        };

        private static bool IsBlocked(Exception ex)
        {
            for (var e = ex; e != null; e = e.InnerException)
            {
                if (e is ArrBlockedAddressException) return true;
            }
            return false;
        }

        private static ArrError TransportError(HttpRequestException ex, bool sent)
        {
            if (IsBlocked(ex)) return new ArrError(ArrErrorKind.BlockedUrl, "The instance's address is not allowed (cloud metadata or link-local range).");
            // Only failures while establishing the connection prove nothing reached the arr.
            var notSent = ex.HttpRequestError is HttpRequestError.NameResolutionError or HttpRequestError.ConnectionError or HttpRequestError.SecureConnectionError or HttpRequestError.ProxyTunnelError;
            if (!sent && notSent)
            {
                var what = ex.HttpRequestError switch
                {
                    HttpRequestError.NameResolutionError => "The host name could not be resolved.",
                    HttpRequestError.SecureConnectionError => "The secure (TLS) connection failed.",
                    _ => "Could not connect. Check the URL and that the app is running.",
                };
                return new ArrError(ArrErrorKind.Unreachable, what);
            }
            return new ArrError(ArrErrorKind.ConnectionLost, "The connection dropped before the instance answered.");
        }

        /// <summary>Normalises a non-success response. Never keeps the <c>description</c> stack trace.</summary>
        internal static async Task<ArrError> ReadErrorAsync(HttpResponseMessage response, CancellationToken cancellationToken)
        {
            var status = (int)response.StatusCode;
            string text;
            try
            {
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                var buffer = new byte[ErrorBodyLimit];
                var read = 0;
                int n;
                while (read < buffer.Length && (n = await stream.ReadAsync(buffer.AsMemory(read), cancellationToken).ConfigureAwait(false)) > 0)
                {
                    read += n;
                }
                text = Encoding.UTF8.GetString(buffer, 0, read);
            }
            catch (Exception ex) when (ex is IOException or HttpRequestException)
            {
                text = string.Empty;
            }

            string? upstreamMessage = null;
            var validation = new List<ArrValidationMessage>();
            try
            {
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                if (root.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in root.EnumerateArray().Take(20))
                    {
                        if (item.ValueKind != JsonValueKind.Object) continue;
                        var msg = Str(item, "errorMessage");
                        if (string.IsNullOrEmpty(msg)) continue;
                        validation.Add(new ArrValidationMessage { Property = Clip(Str(item, "propertyName"), 100), Message = Clip(msg, 300) });
                    }
                }
                else if (root.ValueKind == JsonValueKind.Object)
                {
                    // NzbDroneClientException {message, description}: keep message, drop description (a stack trace).
                    // ProblemDetails {type, title, status, traceId}: keep title.
                    upstreamMessage = Str(root, "message") ?? Str(root, "title");
                }
            }
            catch (JsonException)
            {
                // Not JSON (empty 401 body, HTML error page): use the generic text below.
            }

            var (kind, generic) = status switch
            {
                401 or 403 => (ArrErrorKind.Unauthorized, "The API key was rejected."),
                404 => (ArrErrorKind.NotFound, "Not found. Check the URL (including any URL base)."),
                409 => (ArrErrorKind.Conflict, "The instance reported a conflict."),
                400 or 422 => (ArrErrorKind.Validation, "The instance rejected the request."),
                429 => (ArrErrorKind.RateLimited, "The instance is rate limiting requests."),
                >= 500 => (ArrErrorKind.Server, "The instance reported an internal error."),
                _ => (ArrErrorKind.Server, $"The instance answered HTTP {status}."),
            };
            if (validation.Count > 0) kind = ArrErrorKind.Validation;

            var message = generic;
            if (kind == ArrErrorKind.Validation && validation.Count > 0)
            {
                message = generic + " " + string.Join(" ", validation.Select(v => v.Message));
            }
            else if (!string.IsNullOrWhiteSpace(upstreamMessage) && kind != ArrErrorKind.Unauthorized)
            {
                message = generic + " " + Clip(upstreamMessage!, 300);
            }

            TimeSpan? retryAfter = null;
            if (response.Headers.RetryAfter is { } ra)
            {
                if (ra.Delta is { } delta) retryAfter = delta;
                else if (ra.Date is { } date) retryAfter = date - DateTimeOffset.UtcNow;
            }

            return new ArrError(kind, Clip(message, 600), status) { Validation = validation, RetryAfter = retryAfter };
        }

        private static string? Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static string Clip(string? s, int max)
            => string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s.Substring(0, max) + "…");

        /// <summary>The arr's paged-list envelope.</summary>
        /// <typeparam name="TRecord">Record type.</typeparam>
        internal sealed class ArrPage<TRecord>
        {
            public int Page { get; set; }

            public int PageSize { get; set; }

            public int TotalRecords { get; set; }

            public List<TRecord>? Records { get; set; }
        }
    }

    /// <summary>Marker type for calls whose response body is ignored.</summary>
    public sealed class NoContent
    {
    }

    /// <summary>A read-only stream wrapper that fails once more than a set number of bytes were read.</summary>
    internal sealed class CappedReadStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _limit;
        private long _read;

        public CappedReadStream(Stream inner, long limit)
        {
            _inner = inner;
            _limit = limit;
        }

        public sealed class LimitExceededException : IOException
        {
            public LimitExceededException()
                : base("Response size limit exceeded.")
            {
            }
        }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => _read; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count) => Count(_inner.Read(buffer, offset, count));

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => Count(await _inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false));

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing) _inner.Dispose();
            base.Dispose(disposing);
        }

        private int Count(int n)
        {
            _read += n;
            if (_read > _limit) throw new LimitExceededException();
            return n;
        }
    }
}
