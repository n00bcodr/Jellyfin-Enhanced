using System.Net.Sockets;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;

namespace JE.Tests;

/// <summary>The wire contract and classification rules behind the proxy's <c>requestOutcome</c>.</summary>
public class SeerrRequestOutcomeContractTests
{
    public static TheoryData<string> HostOptions() => new() { "default", "pascal", "camel" };

    private static JsonSerializerOptions Options(string name) => name switch
    {
        "pascal" => Jellyfin.Extensions.Json.JsonDefaults.PascalCaseOptions,
        "camel" => Jellyfin.Extensions.Json.JsonDefaults.CamelCaseOptions,
        _ => Jellyfin.Extensions.Json.JsonDefaults.Options,
    };

    [Theory]
    [MemberData(nameof(HostOptions))]
    public void OutcomeIsALowercaseFiniteStringUnderEveryHostSerializer(string options)
    {
        foreach (var (outcome, wire) in new[] { (SeerrRequestOutcome.Unknown, "unknown"), (SeerrRequestOutcome.Rejected, "rejected"), (SeerrRequestOutcome.NotSent, "not_sent") })
        {
            var json = JsonSerializer.Serialize(SeerrProxyErrorResponse.Create("unreachable", "m", outcome), Options(options));
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(wire, doc.RootElement.GetProperty("requestOutcome").GetString());
            Assert.Equal(wire, outcome.ToWireValue());
            Assert.Equal(new[] { "error", "code", "message", "requestOutcome" }, doc.RootElement.EnumerateObject().Select(p => p.Name));
        }
    }

    [Theory]
    [MemberData(nameof(HostOptions))]
    public void ReadEnvelopesKeepTheirExistingShape(string options)
    {
        var read = JsonSerializer.Serialize(SeerrProxyErrorResponse.Create("unreachable", "m", null), Options(options));
        Assert.Equal("{\"error\":true,\"code\":\"unreachable\",\"message\":\"m\"}", read);
        var permission = JsonSerializer.Serialize(SeerrProxyErrorResponse.Create("no_request_permission", "m", null, error: false), Options(options));
        Assert.Equal("{\"code\":\"no_request_permission\",\"message\":\"m\"}", permission);

        var error = new SeerrError { Code = SeerrErrorCode.Forbidden, HttpStatus = 403, Message = "admin text http://seerr.local", UserMessage = "user text", Url = "http://seerr.local/api/v1/request", CfRay = "ray" };
        Assert.Equal(JsonSerializer.Serialize(error.ToResponseShape(), Options(options)), JsonSerializer.Serialize(error.ToProxyErrorResponse(false, null), Options(options)));
        Assert.Equal(JsonSerializer.Serialize(error.ToAdminResponseShape(), Options(options)), JsonSerializer.Serialize(error.ToProxyErrorResponse(true, null), Options(options)));
        var user = JsonSerializer.Serialize(error.ToProxyErrorResponse(false, SeerrRequestOutcome.Rejected), Options(options));
        Assert.DoesNotContain("seerr.local", user);
        Assert.DoesNotContain("ray", user);
        Assert.EndsWith(",\"requestOutcome\":\"rejected\"}", user);
    }

    [Theory]
    [InlineData(SeerrErrorCode.Unauthorized, 401, SeerrRequestOutcome.Rejected)]
    [InlineData(SeerrErrorCode.Forbidden, 403, SeerrRequestOutcome.Rejected)]
    [InlineData(SeerrErrorCode.UpstreamError, 400, SeerrRequestOutcome.Rejected)]
    [InlineData(SeerrErrorCode.UpstreamError, 409, SeerrRequestOutcome.Rejected)]
    [InlineData(SeerrErrorCode.UpstreamError, 429, SeerrRequestOutcome.Rejected)]
    [InlineData(SeerrErrorCode.UpstreamError, 408, SeerrRequestOutcome.Unknown)]
    [InlineData(SeerrErrorCode.UpstreamError, 500, SeerrRequestOutcome.Unknown)]
    [InlineData(SeerrErrorCode.UpstreamError, 504, SeerrRequestOutcome.Unknown)]
    [InlineData(SeerrErrorCode.HtmlResponse, 200, SeerrRequestOutcome.Unknown)]
    [InlineData(SeerrErrorCode.HtmlResponse, 403, SeerrRequestOutcome.Unknown)]
    [InlineData(SeerrErrorCode.UpstreamRedirect, 302, SeerrRequestOutcome.Unknown)]
    [InlineData(SeerrErrorCode.Cloudflare5xx, 524, SeerrRequestOutcome.Unknown)]
    [InlineData(SeerrErrorCode.ParseError, 201, SeerrRequestOutcome.Unknown)]
    public void OnlySeerrsOwnJson4xxIsADefiniteRejection(SeerrErrorCode code, int status, SeerrRequestOutcome expected)
    {
        Assert.Equal(expected, SeerrRequestOutcomes.ForUpstreamError(new SeerrError { Code = code, HttpStatus = status }));
    }

    public static TheoryData<string, bool> Exceptions() => new()
    {
        { "refused", true },
        { "dns", true },
        { "unreachable", true },
        { "connection-reset-during-connect-category", false },
        { "response-ended", false },
        { "tls", false },
        { "timeout", false },
        { "io", false },
        { "connection-error-without-socket", false },
    };

    [Theory]
    [MemberData(nameof(Exceptions))]
    public void OnlyAFailedConnectProvesAWriteWasNotSent(string kind, bool unsent)
    {
        Exception ex = kind switch
        {
            "refused" => new HttpRequestException(HttpRequestError.ConnectionError, "refused", new SocketException((int)SocketError.ConnectionRefused)),
            "dns" => new HttpRequestException(HttpRequestError.NameResolutionError, "dns", new SocketException((int)SocketError.HostNotFound)),
            "unreachable" => new HttpRequestException(HttpRequestError.ConnectionError, "unreachable", new SocketException((int)SocketError.NetworkUnreachable)),
            "connection-reset-during-connect-category" => new HttpRequestException(HttpRequestError.ConnectionError, "reset", new SocketException((int)SocketError.ConnectionReset)),
            "response-ended" => new HttpRequestException(HttpRequestError.ResponseEnded, "ended"),
            "tls" => new HttpRequestException(HttpRequestError.SecureConnectionError, "tls"),
            "timeout" => new TaskCanceledException("timeout", new TimeoutException()),
            "io" => new IOException("broken pipe", new SocketException((int)SocketError.ConnectionRefused)),
            _ => new HttpRequestException(HttpRequestError.ConnectionError, "no socket detail"),
        };
        Assert.Equal(unsent, SeerrRequestOutcomes.IsProvablyUnsent(ex));
    }

    [Theory]
    [InlineData("{\"id\":1}", true)]
    [InlineData("[]", true)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("{\"id\":", false)]
    [InlineData("<html>", false)]
    public void OnlyACompleteJsonDocumentConfirmsAWrite(string body, bool usable)
    {
        Assert.Equal(usable, SeerrRequestOutcomes.IsUsableWriteResponse(body));
    }
}
