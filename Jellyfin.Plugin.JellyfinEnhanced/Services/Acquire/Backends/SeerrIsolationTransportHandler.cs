using System;
using System.Linq;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends
{
    /// <summary>Every-method Seerr gate. Client names never classify a request as Seerr.</summary>
    public sealed class SeerrIsolationTransportHandler : DelegatingHandler
    {
        public static readonly HttpRequestOptionsKey<SeerrUse> Use = new("JE.SeerrUse");
        public static readonly HttpRequestOptionsKey<long> Epoch = new("JE.BackendEpoch");
        private readonly EffectiveRequestsBackend _backend;
        private readonly Func<PluginConfiguration?> _config;
        private readonly ILogger<SeerrIsolationTransportHandler>? _logger;
        public SeerrIsolationTransportHandler(EffectiveRequestsBackend backend, ILogger<SeerrIsolationTransportHandler> logger) : this(backend, () => JellyfinEnhanced.Instance?.Configuration) { _logger = logger; }
        internal SeerrIsolationTransportHandler(EffectiveRequestsBackend backend, Func<PluginConfiguration?> config) { _backend = backend; _config = config; }
        /// <summary>Tags a Seerr request explicitly, including a generation when the caller captured one.</summary>
        public static void Mark(HttpRequestMessage request, SeerrUse use, long? epoch = null)
        { request.Options.Set(Use, use); if (epoch is long e) request.Options.Set(Epoch, e); }
        /// <summary>
        /// Defense for unmarked avatar/probe traffic: matches the retained origin and base path, not
        /// an entire host shared by /seerr and /sonarr. An origin without a base path owns that origin.
        /// </summary>
        public static bool KnownSeerrAddress(Uri? uri, PluginConfiguration? config)
        {
            if (uri == null || !uri.IsAbsoluteUri || config == null) return false;
            return (config.JellyseerrUrls ?? string.Empty).Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Any(raw => Uri.TryCreate(raw.Trim().TrimEnd('/') + "/", UriKind.Absolute, out var root)
                    && root.Scheme.Equals(uri.Scheme, StringComparison.OrdinalIgnoreCase)
                    && root.IdnHost.Equals(uri.IdnHost, StringComparison.OrdinalIgnoreCase) && root.Port == uri.Port
                    && (NormalizedPath(uri).TrimEnd('/').Equals(NormalizedPath(root).TrimEnd('/'), StringComparison.OrdinalIgnoreCase)
                        || NormalizedPath(uri).StartsWith(NormalizedPath(root).TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase)));
        }
        private static string NormalizedPath(Uri uri)
        {
            var path = Uri.UnescapeDataString(uri.AbsolutePath).Replace('\\', '/');
            var parts = new System.Collections.Generic.List<string>();
            foreach (var part in path.Split('/'))
            {
                if (part is "" or ".") continue;
                if (part == "..") { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); }
                else parts.Add(part);
            }
            return "/" + string.Join("/", parts);
        }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (!request.Options.TryGetValue(Use, out var use) && !KnownSeerrAddress(request.RequestUri, _config())
                && _backend.Current.IsolationVersion != 0)
                return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            try
            {
                var admission = _backend.AdmitSeerr(use, cancellationToken, request.Options.TryGetValue(Epoch, out var epoch) ? epoch : null);
                try
                {
                    var response = await base.SendAsync(request, admission.Token).ConfigureAwait(false);
                    try
                    {
                        admission.DemandCurrent();
                        response.Content = new AdmittedContent(response.Content, admission);
                        return response;
                    }
                    catch { response.Dispose(); throw; }
                }
                catch { admission.Dispose(); throw; }
            }
            catch (BackendDisabledException ex) { _logger?.LogInformation("[RequestsBackend] Seerr transport denied: {Reason}", ex.Reason); throw; }
        }
        // HttpClient buffers/streams the body outside the handler. Keep the admission through that
        // read (or disposal), so adopting JE cannot finish while an old Seerr body is still arriving.
        private sealed class AdmittedContent : HttpContent
        {
            private readonly HttpContent _inner;
            private readonly EffectiveRequestsBackend.Admission _admission;
            public AdmittedContent(HttpContent inner, EffectiveRequestsBackend.Admission admission)
            {
                _inner = inner; _admission = admission;
                foreach (var header in inner.Headers) Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            protected override bool TryComputeLength(out long length) { length = _inner.Headers.ContentLength ?? 0; return _inner.Headers.ContentLength.HasValue; }
            protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => SerializeToStreamAsync(stream, context, CancellationToken.None);
            protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken ct)
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _admission.Token);
                try { await _inner.CopyToAsync(stream, linked.Token).ConfigureAwait(false); _admission.DemandCurrent(); }
                finally { _admission.Dispose(); }
            }
            protected override Task<Stream> CreateContentReadStreamAsync() => CreateContentReadStreamAsync(CancellationToken.None);
            protected override async Task<Stream> CreateContentReadStreamAsync(CancellationToken ct)
            {
                try
                {
                    _admission.DemandCurrent();
                    using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _admission.Token);
                    var stream = await _inner.ReadAsStreamAsync(linked.Token).ConfigureAwait(false);
                    _admission.DemandCurrent();
                    return new AdmittedStream(stream, _admission);
                }
                catch { _admission.Dispose(); throw; }
            }
            protected override void Dispose(bool disposing) { if (disposing) { _inner.Dispose(); _admission.Dispose(); } base.Dispose(disposing); }
        }
        private sealed class AdmittedStream(Stream inner, EffectiveRequestsBackend.Admission admission) : Stream
        {
            private bool _finished;
            public override bool CanRead => inner.CanRead;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
            public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();
            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
            {
                if (_finished) return 0;
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, admission.Token);
                try
                {
                    admission.DemandCurrent();
                    var read = await inner.ReadAsync(buffer, linked.Token).ConfigureAwait(false);
                    admission.DemandCurrent();
                    if (read == 0 && buffer.Length > 0) { _finished = true; admission.Dispose(); }
                    return read;
                }
                catch { _finished = true; admission.Dispose(); throw; }
            }
            protected override void Dispose(bool disposing) { if (disposing) { inner.Dispose(); admission.Dispose(); _finished = true; } base.Dispose(disposing); }
            public override void Flush() => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

    }
}

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends
{
    /// <summary>
    /// The unnamed fallback keeps its original redirect behavior in v0. In isolated mode redirects
    /// are returned to the caller, preventing an underlying handler from bypassing per-send admission.
    /// </summary>
    public sealed class BackendFallbackTransport : HttpMessageHandler
    {
        private readonly HttpMessageInvoker _legacy = new(new HttpClientHandler());
        private readonly HttpMessageInvoker _isolated = new(new HttpClientHandler { AllowAutoRedirect = false });
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => (EffectiveRequestsBackend.Shared.Current.IsolationVersion == 0 ? _legacy : _isolated).SendAsync(request, ct);
        protected override void Dispose(bool disposing) { if (disposing) { _legacy.Dispose(); _isolated.Dispose(); } base.Dispose(disposing); }
    }
}
