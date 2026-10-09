using System.Net;
using System.Text;

namespace JE.Tests;

internal sealed class IntegrationTransport(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler, IHttpClientFactory
{
    public int Calls;
    public HttpClient CreateClient(string name) => new(this, false);
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Interlocked.Increment(ref Calls);
        return send(request, ct);
    }
    public static HttpResponseMessage Response(string body = "{}", int status = 200, string type = "application/json") =>
        new((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, type) };
}
