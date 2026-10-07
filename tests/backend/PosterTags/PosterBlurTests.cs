using Jellyfin.Plugin.JellyfinEnhanced.Services;
using SkiaSharp;
namespace JE.Tests;

public class PosterBlurTests
{
    internal static byte[] Source(int width=96, int height=64, bool inverse=false)
    {
        using var bitmap = new SKBitmap(width,height);
        for(int y=0;y<height;y++) for(int x=0;x<width;x++) bitmap.SetPixel(x,y, ((x/4+y/4)%2==0)^inverse ? SKColors.White : SKColors.Black);
        using var image=SKImage.FromBitmap(bitmap); using var encoded=image.Encode(SKEncodedImageFormat.Png,100); return encoded.ToArray();
    }
    internal static double Contrast(SKBitmap image) { var pixels=image.Pixels; var mean=pixels.Average(p=>(double)p.Red); return pixels.Average(p=>Math.Abs(p.Red-mean)); }
    [Theory]
    [InlineData(1f)][InlineData(15f)][InlineData(100f)]
    public void Blur_reduces_detail_returns_jpeg_and_preserves_dimensions(float sigma)
    {
        using var f=new CoreFixture(); var service=new ImageBlurService(f.Logger); var source=Source();
        var result=service.Blur(source,sigma,null); Assert.NotNull(result);
        using var data=SKData.CreateCopy(result); using var codec=SKCodec.Create(data); using var output=SKBitmap.Decode(result);
        Assert.Equal(SKEncodedImageFormat.Jpeg,codec.EncodedFormat); Assert.Equal(96,output.Width); Assert.Equal(64,output.Height);
        using var original=SKBitmap.Decode(source); Assert.True(Contrast(output)<Contrast(original)*.8);
    }
    [Fact]
    public void Blur_clamps_sigma_and_rejects_corrupt_inputs()
    {
        using var f=new CoreFixture(); var service=new ImageBlurService(f.Logger); var source=Source();
        Assert.Equal(service.Blur(source,1,null),service.Blur(source,-20,null));
        Assert.Equal(service.Blur(source,100,null),service.Blur(source,1000,null));
        Assert.Null(service.Blur([],40,null)); Assert.Null(service.Blur([1,2,3],40,null));
        Assert.Null(service.ResizeToMatch([],source,null)); Assert.Null(service.ResizeToMatch([1,2,3],source,null));
    }
    [Fact]
    public void Stock_card_hides_all_pixels_even_for_corrupt_input_and_fallback_is_decodable()
    {
        using var f=new CoreFixture(); var service=new ImageBlurService(f.Logger);
        using var output=SKBitmap.Decode(service.StockCard(Source(),null));
        Assert.Equal(96,output.Width); Assert.Equal(64,output.Height);
        Assert.All(output.Pixels,p=>Assert.InRange(p.Red,14,18));
        using var corrupt=SKBitmap.Decode(service.StockCard([1,2,3],null)); Assert.Equal(600,corrupt.Width); Assert.Equal(900,corrupt.Height);
        using var fallback=SKBitmap.Decode(service.HardcodedFallbackJpeg); Assert.Equal(16,fallback.Width); Assert.Equal(16,fallback.Height);
    }
    [Theory]
    [InlineData(128,32,128,32)][InlineData(2000,100,1920,96)]
    public void Resize_and_blur_bound_output_dimensions(int width,int height,int expectedWidth,int expectedHeight)
    {
        using var f=new CoreFixture(); var service=new ImageBlurService(f.Logger); var reference=Source(width,height);
        using var resized=SKBitmap.Decode(service.ResizeToMatch(Source(),reference,null)); Assert.Equal(expectedWidth,resized.Width); Assert.Equal(expectedHeight,resized.Height);
        using var blurred=SKBitmap.Decode(service.Blur(reference,10,null)); Assert.Equal(expectedWidth,blurred.Width); Assert.Equal(expectedHeight,blurred.Height);
        using var stock=SKBitmap.Decode(service.StockCard(reference,null)); Assert.Equal(expectedWidth,stock.Width); Assert.Equal(expectedHeight,stock.Height);
    }
    [Fact]
    public async Task Cached_concurrent_outputs_remain_identical_and_distinct_keys_are_isolated()
    {
        using var f=new CoreFixture(); var service=new ImageBlurService(f.Logger); var source=Source();
        var expected=service.Blur(source,10,"first");
        var results=await Task.WhenAll(Enumerable.Range(0,20).Select(_=>Task.Run(()=>service.Blur(source,10,"first"))));
        Assert.All(results,r=>Assert.Same(expected,r));
        var second=service.Blur(Source(32,16),10,"second"); using var output=SKBitmap.Decode(second); Assert.Equal(32,output.Width);
        Assert.Same(expected,service.Blur(source,10,"first"));
    }
}
