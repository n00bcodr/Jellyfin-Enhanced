using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // A live capability, never an identity or an authorization verdict. Only the documented
    // admission owners may construct one. Transport checks its lifetime at the actual send.
    internal sealed class MetadataAdmission : IDisposable
    {
        private static readonly AsyncLocal<MetadataAdmission?> Ambient = new();
        private readonly MetadataAdmission? _previous;
        private int _ended;
        internal SemaphoreSlim Sends { get; } = new(1, 1);
        private readonly System.Collections.Generic.List<Task> _reads = new();
        internal void Retain(Task read) { lock (_reads) _reads.Add(read); }
        internal async Task DrainAsync()
        {
            while (true)
            {
                Task[] reads;
                lock (_reads) { if (_reads.Count == 0) return; reads = _reads.ToArray(); _reads.Clear(); }
                try { await Task.WhenAll(reads).ConfigureAwait(false); }
                catch (Exception) { /* The original waiter observes its outcome; ownership still drains every read. */ }
            }
        }
        internal MetadataAdmission(string owner, bool images = false)
        {
            Owner = owner;
            Images = images;
            _previous = Ambient.Value;
            Ambient.Value = this;
        }
        internal string Owner { get; }
        internal bool Images { get; }
        internal bool Active => Volatile.Read(ref _ended) == 0;
        internal static MetadataAdmission? Current => Ambient.Value is { Active: true } value ? value : null;
        internal static MetadataAdmission Required => Current ?? throw new InvalidOperationException("TMDB metadata has no live admission.");
        public void Dispose() { Interlocked.Exchange(ref _ended, 1); Ambient.Value = _previous; }
    }

    /// <summary>The sole TMDB HTTP sender. A live admission is mandatory, including retries and autonomous reads.</summary>
    internal static class TmdbTransport
    {
        internal const string ClientName = "JellyfinEnhanced.Tmdb";

        internal static async Task<HttpResponseMessage> SendAsync(IHttpClientFactory factory, HttpRequestMessage request,
            MetadataAdmission admission, CancellationToken ct, string clientName = "", Action? beforeSend = null)
        {
            ArgumentNullException.ThrowIfNull(admission);
            if (!admission.Active) throw new InvalidOperationException("TMDB admission ended before transmission.");
            if (request.RequestUri is not { Scheme: "https", Port: 443 } uri
                || uri.Host != (admission.Images ? "image.tmdb.org" : "api.themoviedb.org"))
                throw new InvalidOperationException("TMDB transport requires its fixed upstream host.");
            await admission.Sends.WaitAsync(ct).ConfigureAwait(false);
            var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            try
            {
                if (!admission.Active) throw new InvalidOperationException("TMDB admission ended while waiting to send.");
                // Keep the checked-client inventory explicit; both clients retain the TMDB egress handler.
                var client = PluginHttp.CheckedClient(clientName switch
                {
                    "" => factory.CreateClient(ClientName),
                    Acquire.Lists.Sources.SourceHttp.ClientName => factory.CreateClient(Acquire.Lists.Sources.SourceHttp.ClientName),
                    _ => throw new InvalidOperationException("TMDB transport allows only the metadata or list-source HTTP client."),
                });
                TmdbEgressHandler.Attach(request, admission);
                beforeSend?.Invoke();
                NativeDetails.MetadataTaskProbe.Emit(new(null, request.RequestUri.AbsolutePath, "transport", admission));
                var response = await BoundedBody.SendAsync(client, request, timeout.Token).ConfigureAwait(false);
                response.Content = new AdmittedContent(response.Content, admission.Sends, timeout);
                return response;
            }
            catch { timeout.Dispose(); admission.Sends.Release(); throw; }
        }

        // One capability can have sequential retries/subresources, never parallel sends. The send
        // turn ends only after response-body disposal, retaining the original streaming/body cap.
        private sealed class AdmittedContent : HttpContent
        {
            private readonly HttpContent _inner;
            private readonly SemaphoreSlim _turn;
            private readonly CancellationTokenSource _timeout;
            private int _disposed;
            internal AdmittedContent(HttpContent inner, SemaphoreSlim turn, CancellationTokenSource timeout)
            {
                _inner = inner; _turn = turn; _timeout = timeout;
                foreach (var header in inner.Headers) Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            protected override Task SerializeToStreamAsync(System.IO.Stream stream, System.Net.TransportContext? context)
                => _inner.CopyToAsync(stream, _timeout.Token);
            protected override async Task SerializeToStreamAsync(System.IO.Stream stream, System.Net.TransportContext? context, CancellationToken ct)
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _timeout.Token);
                await _inner.CopyToAsync(stream, linked.Token).ConfigureAwait(false);
            }
            protected override Task<System.IO.Stream> CreateContentReadStreamAsync() => _inner.ReadAsStreamAsync();
            protected override Task<System.IO.Stream> CreateContentReadStreamAsync(CancellationToken ct) => _inner.ReadAsStreamAsync(ct);
            protected override bool TryComputeLength(out long length) { length = _inner.Headers.ContentLength ?? 0; return _inner.Headers.ContentLength.HasValue; }
            protected override void Dispose(bool disposing)
            {
                if (disposing && Interlocked.Exchange(ref _disposed, 1) == 0) { try { _inner.Dispose(); } finally { _timeout.Dispose(); _turn.Release(); } }
                base.Dispose(disposing);
            }
        }

        internal static async Task<HttpResponseMessage> GetAsync(IHttpClientFactory factory, string url,
            MetadataAdmission admission, CancellationToken ct, string clientName = "", bool http2 = false, Action<HttpRequestMessage>? prepare = null, Action? beforeSend = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (http2) { request.Version = System.Net.HttpVersion.Version20; request.VersionPolicy = HttpVersionPolicy.RequestVersionOrLower; }
            prepare?.Invoke(request);
            return await SendAsync(factory, request, admission, ct, clientName, beforeSend).ConfigureAwait(false);
        }
    }
}
