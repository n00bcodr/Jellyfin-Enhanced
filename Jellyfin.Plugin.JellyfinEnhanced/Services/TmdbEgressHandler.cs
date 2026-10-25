using System;
using System.Diagnostics.Metrics;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Typed local refusal, deliberately distinct from an upstream HTTP failure. No URL, credentials
    // or provider body is exposed. Generic clients never mint metadata admission.
    internal sealed class TmdbEgressRefusedException : HttpRequestException
    {
        internal const string SafeMessage = "TMDB hosts are checked through the metadata source; use the TMDB test instead";
        internal TmdbEgressRefusedException() : base(SafeMessage) { }
        internal string Reason => "tmdb_admission_required";
    }

    internal sealed class TmdbEgressHandler : DelegatingHandler
    {
        private sealed class Permit
        {
            private readonly HttpRequestMessage _original;
            internal MetadataAdmission Admission { get; }
            internal Uri Target { get; }
            internal Permit(MetadataAdmission admission, HttpRequestMessage original)
            { Admission = admission; _original = original; Target = original.RequestUri!; }
            private HttpRequestMessage? _wire;
            private int _originalUsed;
            private int _wireUsed;

            internal bool Use(HttpRequestMessage request)
                => ReferenceEquals(request, _original) ? Interlocked.Exchange(ref _originalUsed, 1) == 0
                    : ReferenceEquals(request, Volatile.Read(ref _wire)) && Interlocked.Exchange(ref _wireUsed, 1) == 0;

            internal void Forward(HttpRequestMessage request, HttpRequestMessage copy)
            {
                if (!ReferenceEquals(request, _original) || Volatile.Read(ref _originalUsed) == 0
                    || Interlocked.CompareExchange(ref _wire, copy, null) != null)
                {
                    RecordRefusal("generic_http");
                    throw new TmdbEgressRefusedException();
                }
            }
        }
        private static readonly HttpRequestOptionsKey<Permit> Capability = new("JellyfinEnhanced.TmdbAdmission");
        private static readonly Meter Metrics = new("JellyfinEnhanced.TmdbEgress");
        private static readonly Counter<long> Refused = Metrics.CreateCounter<long>("je.tmdb.egress.refused");

        // These are also the plugin's configured upstreams: neither base nor image URL is user
        // configurable. Include the historical image alias and normalize IDN/case/trailing dots.
        // If configurable upstreams are introduced, their hosts must be added here before use.
        internal static bool IsTmdb(Uri uri)
        {
            var host = uri.IdnHost.TrimEnd('.');
            return host.Equals("api.themoviedb.org", StringComparison.OrdinalIgnoreCase)
                || host.Equals("image.tmdb.org", StringComparison.OrdinalIgnoreCase)
                || host.Equals("images.tmdb.org", StringComparison.OrdinalIgnoreCase);
        }

        internal static void RecordRefusal(string route) => Refused.Add(1, new System.Collections.Generic.KeyValuePair<string, object?>("route", route));

        // Only TmdbTransport calls this, after admission and send-turn acquisition. The private
        // option value cannot be manufactured by generic clients; ambient admission isn't enough.
        internal static void Attach(HttpRequestMessage request, MetadataAdmission admission)
            => request.Options.Set(Capability, new Permit(admission, request));

        // An Options value copied by a generic client is not a new send capability. Only the
        // private forwarding adapter can register the single wire copy of this checked request.
        internal static void CopyOptions(HttpRequestMessage request, HttpRequestMessage copy)
        {
            foreach (var option in request.Options)
                if (option.Key != Capability.Key) copy.Options.Set(new HttpRequestOptionsKey<object?>(option.Key), option.Value);
            if (request.Options.TryGetValue(Capability, out var permit))
            {
                permit.Forward(request, copy);
                copy.Options.Set(Capability, permit);
            }
        }

        internal static bool HasCapability(HttpRequestMessage request) => request.Options.TryGetValue(Capability, out _);

        private static void Check(HttpRequestMessage request)
        {
            if (request.RequestUri is not { } uri) return;
            // A virtual-host override must not turn a generic/IP target into an unowned TMDB read.
            Uri? authority = null;
            var suppliedHost = request.Headers.Host;
            var reservedHostHeader = suppliedHost != null
                && Uri.TryCreate("https://" + suppliedHost, UriKind.Absolute, out authority) && IsTmdb(authority);
            if (!IsTmdb(uri) && !reservedHostHeader) return;
            if (request.Options.TryGetValue(Capability, out var permit)
                && permit.Admission.Active && permit.Target == uri
                && uri.Scheme == "https" && uri.Port == 443
                && uri.IdnHost == (permit.Admission.Images ? "image.tmdb.org" : "api.themoviedb.org")
                && (suppliedHost == null || authority != null && authority.Port == uri.Port
                    && authority.IdnHost.TrimEnd('.').Equals(uri.IdnHost.TrimEnd('.'), StringComparison.OrdinalIgnoreCase))
                && permit.Use(request)) return;
            RecordRefusal("generic_http");
            throw new TmdbEgressRefusedException();
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Check(request);
            return base.SendAsync(request, cancellationToken);
        }

        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Check(request);
            return base.Send(request, cancellationToken);
        }
    }

    // Applies only to JE-owned names, never the host's default/typed clients (Jellyfin's own
    // metadata provider must retain its independent transport). Redirects must re-enter the guard.
    internal sealed class TmdbEgressFilter : IHttpMessageHandlerBuilderFilter
    {
        public Action<HttpMessageHandlerBuilder> Configure(Action<HttpMessageHandlerBuilder> next) => builder =>
        {
            next(builder);
            if (!PluginHttp.Owns(builder.Name)) return;
            var redirects = builder.PrimaryHandler switch
            {
                HttpClientHandler h => h.AllowAutoRedirect,
                SocketsHttpHandler h => h.AllowAutoRedirect,
                _ => false,
            };
            if (builder.PrimaryHandler is HttpClientHandler http) http.AllowAutoRedirect = false;
            if (builder.PrimaryHandler is SocketsHttpHandler sockets) sockets.AllowAutoRedirect = false;
            builder.AdditionalHandlers.Insert(0, new TmdbEgressHandler());
            if (redirects) builder.AdditionalHandlers.Insert(0, new TmdbRedirectHandler());
        };
    }

    // Preserve the default client's redirect behavior, checking every hop before any
    // socket. Named service clients already reject redirects and retain that contract. No capability
    // is copied to a redirected request. A metadata source redirect therefore cannot borrow it.
    internal sealed class TmdbRedirectHandler : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var current = request;
            try
            {
                for (var count = 0; ; count++)
                {
                    var response = await base.SendAsync(current, cancellationToken).ConfigureAwait(false);
                    if (TmdbEgressHandler.HasCapability(request) || count >= 20 || response.StatusCode is not (System.Net.HttpStatusCode.MovedPermanently or System.Net.HttpStatusCode.Found
                            or System.Net.HttpStatusCode.SeeOther or System.Net.HttpStatusCode.TemporaryRedirect or System.Net.HttpStatusCode.PermanentRedirect)
                        || response.Headers.Location is not { } location) return response;
                    var target = location.IsAbsoluteUri ? location : new Uri(current.RequestUri!, location);
                    if (target.Scheme is not ("http" or "https") || current.RequestUri!.Scheme == "https" && target.Scheme != "https") return response;
                    response.Dispose();
                    var toGet = response.StatusCode == System.Net.HttpStatusCode.SeeOther && current.Method != HttpMethod.Head
                        || response.StatusCode is System.Net.HttpStatusCode.MovedPermanently or System.Net.HttpStatusCode.Found && current.Method == HttpMethod.Post;
                    var redirected = new HttpRequestMessage(toGet ? HttpMethod.Get : current.Method, target)
                    { Content = toGet ? null : current.Content, Version = current.Version, VersionPolicy = current.VersionPolicy };
                    foreach (var header in current.Headers)
                        if (!header.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase) && !header.Key.Equals("Host", StringComparison.OrdinalIgnoreCase)
                            && !header.Key.Equals("Cookie", StringComparison.OrdinalIgnoreCase)) redirected.Headers.TryAddWithoutValidation(header.Key, header.Value);
                    if (toGet) redirected.Headers.TransferEncodingChunked = false;
                    if (current != request) { current.Content = null; current.Dispose(); }
                    current = redirected;
                }
            }
            finally { if (current != request) { current.Content = null; current.Dispose(); } }
        }
    }

    // Every plugin factory acquisition goes through this boundary. Besides the production named
    // pipelines, it protects supplied factories (including a factory returning a bare HttpClient).
    // The outer client preserves the factory client's configuration and streaming body ownership.
    internal static class PluginHttp
    {
        internal const string DefaultClient = "JellyfinEnhanced.Http";
        internal static bool Owns(string? name) => name is DefaultClient or Helpers.Jellyseerr.SeerrHttpHelper.NamedClient
            or Arr.ArrHttp.ClientName or Acquire.Notify.NotifyEndpoints.ClientName or Acquire.Lists.Sources.SourceHttp.ClientName;

        internal static HttpClient CreateClient(IHttpClientFactory factory, string? name = null)
        {
            var ownedName = string.IsNullOrEmpty(name) ? DefaultClient : name;
            if (!Owns(ownedName)) throw new ArgumentException("HTTP client must use a registered plugin pipeline.", nameof(name));
            return CheckedClient(factory.CreateClient(ownedName));
        }

        // Explicit factory names in the sole TMDB transport still use the same runtime wrapper.
        internal static HttpClient CheckedClient(HttpClient inner)
        {
            var client = new HttpClient(new TmdbEgressHandler { InnerHandler = new FactoryClientHandler(inner) })
            {
                BaseAddress = inner.BaseAddress,
                Timeout = inner.Timeout,
                MaxResponseContentBufferSize = inner.MaxResponseContentBufferSize,
                DefaultRequestVersion = inner.DefaultRequestVersion,
                DefaultVersionPolicy = inner.DefaultVersionPolicy,
            };
            foreach (var header in inner.DefaultRequestHeaders) client.DefaultRequestHeaders.TryAddWithoutValidation(header.Key, header.Value);
            return client;
        }

        private sealed class FactoryClientHandler(HttpClient client) : HttpMessageHandler
        {
            private static HttpRequestMessage Copy(HttpRequestMessage request)
            {
                var copy = new HttpRequestMessage(request.Method, request.RequestUri)
                { Content = request.Content, Version = request.Version, VersionPolicy = request.VersionPolicy };
                foreach (var header in request.Headers) copy.Headers.TryAddWithoutValidation(header.Key, header.Value);
                TmdbEgressHandler.CopyOptions(request, copy);
                return copy;
            }
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                using var copy = Copy(request);
                try
                {
                    var response = await client.SendAsync(copy, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
                    response.RequestMessage = request;
                    return response;
                }
                finally { copy.Content = null; } // The original request owns its content.
            }
            protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                using var copy = Copy(request);
                try
                {
                    var response = client.Send(copy, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                    response.RequestMessage = request;
                    return response;
                }
                finally { copy.Content = null; }
            }
            protected override void Dispose(bool disposing) { if (disposing) client.Dispose(); base.Dispose(disposing); }
        }
    }
}
