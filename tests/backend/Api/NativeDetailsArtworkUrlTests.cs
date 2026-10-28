#if JF12
using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace JE.Tests;

public class NativeDetailsArtworkUrlTests
{
    [Theory]
    [InlineData("/poster.jpg", "w500", "image/jpeg")]
    [InlineData("/backdrop.jpg", "w1280", "image/jpeg")]
    [InlineData("/logo.png", "w300", "image/png")]
    [InlineData("/profile.jpg", "w185", "image/jpeg")]
    [InlineData("/season.webp", "w342", "image/webp")]
    [InlineData("/episode.jpg", "w780", "image/jpeg")]
    public async Task ArtworkUsesTheRequestedCdnSizeAndFilePath(string path, string size, string contentType)
    {
        var expected = new Uri("https://image.tmdb.org/t/p/" + size + path);
        var sent = new List<Uri>();
        var bytes = new byte[] { 1, 2, 3 };
        using var network = new IntegrationTransport((request, _) =>
        {
            sent.Add(request.RequestUri!);
            // Unlike a catch-all image fake, this models the CDN's exact resource lookup.
            var response = new HttpResponseMessage(request.RequestUri == expected ? HttpStatusCode.OK : HttpStatusCode.NotFound)
            {
                Content = new ByteArrayContent(bytes),
            };
            response.Content.Headers.ContentType = new(contentType);
            return Task.FromResult(response);
        });
        var factory = new NamedFactory(network);
        var artwork = new NativeDetailsArtwork(factory);
        var viewer = Guid.NewGuid();

        var result = await artwork.FetchAsync(path, size, viewer, CancellationToken.None);

        Assert.Equal(expected, Assert.Single(sent));
        Assert.Equal(TmdbTransport.ClientName, Assert.Single(factory.Names));
        Assert.NotNull(result);
        Assert.Equal(bytes, result.Value.Bytes);
        Assert.Equal(contentType, result.Value.ContentType);
        // A second viewer can reuse public source bytes, with no second upstream request.
        var cached = await artwork.FetchAsync(path, size, Guid.NewGuid(), CancellationToken.None);
        Assert.NotNull(cached);
        Assert.Equal(bytes, cached.Value.Bytes);
        Assert.Single(sent);
        Assert.Equal(0, artwork.InFlightCount);
    }

    private sealed class NamedFactory(IHttpClientFactory inner) : IHttpClientFactory
    {
        internal List<string> Names { get; } = new();
        public HttpClient CreateClient(string name)
        {
            Names.Add(name);
            return inner.CreateClient(name);
        }
    }
}
#endif
