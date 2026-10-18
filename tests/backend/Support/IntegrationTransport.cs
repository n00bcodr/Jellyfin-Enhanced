using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace JE.Tests;

internal sealed class IntegrationTransport(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler, IHttpClientFactory
{
    public int Calls;

    /// <summary>Runs as a request reaches the transport check (the last moment before it): a flip made here is the last one.</summary>
    public Action<HttpRequestMessage>? BeforeGate;

    /// <summary>Each write (not GET/HEAD) the clients sent or tried, and whether the transport check saw it as automatic.</summary>
    public List<(string Method, string Path, bool Checked)> Writes { get; } = new();

    /// <summary>Whether the transport check saw each write as automatic.</summary>
    public IEnumerable<bool> AutomationChecks => Writes.Select(w => w.Checked);

    // Every client is the production chain: the transport check (AutomationTransportHandler), as in
    // PluginServiceRegistrator, with this test's hook just outside it and these fakes as the network.
    public HttpClient CreateClient(string name)
        => new(new LastMoment(this) { InnerHandler = new AutomationTransportHandler { InnerHandler = new Borrowed(this) } });

    private sealed class Borrowed(IntegrationTransport transport) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => transport.SendAsync(request, ct);
        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken ct) => transport.SendAsync(request, ct).GetAwaiter().GetResult();
    }

    private sealed class LastMoment(IntegrationTransport transport) : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            transport.BeforeGate?.Invoke(request);
            try { return await base.SendAsync(request, ct).ConfigureAwait(false); }
            finally { Record(request); }
        }

        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken ct)
        {
            transport.BeforeGate?.Invoke(request);
            try { return base.Send(request, ct); }
            finally { Record(request); }
        }

        private void Record(HttpRequestMessage request)
        {
            if (request.Method == HttpMethod.Get || request.Method == HttpMethod.Head) return;
            lock (transport.Writes)
                if (transport.Writes.Count < 1000)
                    transport.Writes.Add((request.Method.Method, request.RequestUri!.AbsolutePath,
                        request.Options.TryGetValue(AutomationTransportHandler.Checked, out var seen) && seen));
        }
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Interlocked.Increment(ref Calls);
        return send(request, ct);
    }

    public static HttpResponseMessage Response(string body = "{}", int status = 200, string type = "application/json") =>
        new((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, type) };
}
