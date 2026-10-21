using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages;
using SkiaSharp;

namespace JE.Tests;

// The list poster collage renderer: real SkiaSharp decode, layout and JPEG encode. Every expectation is written from the
// layout rules (independent coordinates and colours), never produced by the renderer itself; the decoded output is
// compared with a reference drawn with plain rectangle fills, sampled at cell centres and edges, and (for one poster on
// a square) measured for a blurred, darkened backdrop. Set JE_COLLAGE_PIXEL_ARTIFACTS to a directory to keep the
// rendered images, the reference/diff sheets and the sampled values.
public class ListsCollageRendererTests
{
    private static readonly SKColor Red = new(220, 30, 30);
    private static readonly SKColor Green = new(30, 200, 30);
    private static readonly SKColor Blue = new(30, 60, 220);
    private static readonly SKColor Yellow = new(230, 220, 30);
    private static readonly SKColor Magenta = new(200, 30, 200);
    private static readonly SKColor[] Colors = { Red, Green, Blue, Yellow, Magenta };

    // JPEG quality 90 drifts a flat colour by a few levels; chroma subsampling smears 8-16 px at a colour edge.
    private const int PointTolerance = 40;
    private const double CellMeanTolerance = 8.0;
    private const int EdgeInset = 12;

    // ---- the expected cells, written out per shape and count (not taken from the renderer's own layout) -------------

    private static readonly Dictionary<(bool Square, int Count), SKRectI[]> ExpectedCells = new()
    {
        [(true, 2)] = new[] { new SKRectI(0, 0, 300, 600), new SKRectI(300, 0, 600, 600) },
        [(true, 3)] = new[] { new SKRectI(0, 0, 300, 600), new SKRectI(300, 0, 600, 300), new SKRectI(300, 300, 600, 600) },
        [(true, 4)] = new[] { new SKRectI(0, 0, 300, 300), new SKRectI(300, 0, 600, 300), new SKRectI(0, 300, 300, 600), new SKRectI(300, 300, 600, 600) },
        [(false, 1)] = new[] { new SKRectI(0, 0, 400, 600) },
        [(false, 2)] = new[] { new SKRectI(0, 0, 200, 600), new SKRectI(200, 0, 400, 600) },
        [(false, 3)] = new[] { new SKRectI(0, 0, 200, 600), new SKRectI(200, 0, 400, 300), new SKRectI(200, 300, 400, 600) },
        [(false, 4)] = new[] { new SKRectI(0, 0, 200, 300), new SKRectI(200, 0, 400, 300), new SKRectI(0, 300, 200, 600), new SKRectI(200, 300, 400, 600) },
    };

    [Theory]
    [InlineData(2, true)]
    [InlineData(3, true)]
    [InlineData(4, true)]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(3, false)]
    [InlineData(4, false)]
    public void EachCountAndShapeFillsItsCellsInOrderEdgeToEdge(int count, bool square)
    {
        var shape = square ? ListCollageShape.Square : ListCollageShape.Poster;
        var posters = Enumerable.Range(0, count).Select(i => Flat(Colors[i])).ToList();

        var result = ListCollageRenderer.Render(posters, shape);

        Assert.NotNull(result);
        using var actual = Decode(result!.Jpeg);
        var (width, height) = square ? (600, 600) : (400, 600);
        Assert.Equal((width, height), (actual.Width, actual.Height));
        Assert.Equal((width, height), (result.Width, result.Height));
        Assert.Equal(Enumerable.Range(0, count), result.UsedInputs);

        var cells = ExpectedCells[(square, count)];
        using var expected = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(expected))
        {
            for (var i = 0; i < cells.Length; i++)
            {
                using var paint = new SKPaint { Color = Colors[i] };
                canvas.DrawRect(new SKRect(cells[i].Left, cells[i].Top, cells[i].Right, cells[i].Bottom), paint);
            }
        }

        var samples = new List<string>();
        for (var i = 0; i < cells.Length; i++)
        {
            var c = cells[i];
            var points = new[]
            {
                (c.Left + (c.Width / 2), c.Top + (c.Height / 2)),
                (c.Left + EdgeInset, c.Top + EdgeInset),
                (c.Right - 1 - EdgeInset, c.Top + EdgeInset),
                (c.Left + EdgeInset, c.Bottom - 1 - EdgeInset),
                (c.Right - 1 - EdgeInset, c.Bottom - 1 - EdgeInset),
            };
            foreach (var (x, y) in points)
            {
                var pixel = actual.GetPixel(x, y);
                samples.Add(Sample($"cell{i}", x, y, Colors[i], pixel));
                AssertNear(Colors[i], pixel, $"cell {i} at ({x},{y})");
            }

            var mean = MeanAbsDiff(actual, expected, Inset(c, EdgeInset));
            samples.Add(FormattableString.Invariant($"cell{i} mean-abs-diff {mean:F2}"));
            Assert.True(mean < CellMeanTolerance, FormattableString.Invariant($"cell {i} differs from its flat colour by {mean:F2} on average"));
        }

        Keep($"flat-{(square ? "square" : "poster")}-{count}", result.Jpeg, actual, expected, samples);
    }

    [Fact]
    public void OnePosterOnASquareIsFittedWholeOnADarkenedBlurredCopy()
    {
        // Top half red, bottom half blue (2:3). The backdrop is the poster cover-filled (the middle 600 of 900 rows, so
        // the seam lands on y=300), blurred and darkened; the poster itself is fitted to the height: x 100..500.
        var poster = Banded(342, 513, Red, Blue);
        var result = ListCollageRenderer.Render(new[] { poster }, ListCollageShape.Square);

        Assert.NotNull(result);
        using var actual = Decode(result!.Jpeg);
        Assert.Equal((600, 600), (actual.Width, actual.Height));
        var samples = new List<string>();
        SKColor At(int x, int y, string label)
        {
            var pixel = actual.GetPixel(x, y);
            samples.Add(Sample(label, x, y, null, pixel));
            return pixel;
        }

        // The fitted poster: sharp, full colour, exactly 400 px wide.
        AssertNear(Red, At(300, 150, "poster-top"), "poster top half");
        AssertNear(Blue, At(300, 450, "poster-bottom"), "poster bottom half");
        AssertNear(Red, At(100 + EdgeInset, 200, "poster-left-edge"), "poster's left edge at x=100");
        AssertNear(Blue, At(499 - EdgeInset, 400, "poster-right-edge"), "poster's right edge at x=500");
        AssertNear(Red, At(300, 300 - EdgeInset, "poster-above-seam"), "the poster's own seam is not blurred");
        AssertNear(Blue, At(300, 300 + EdgeInset, "poster-below-seam"), "the poster's own seam is not blurred");

        // Backdrop corners: the poster's colours (red above, blue below), darkened by the shade (black at 115/255) and
        // further at the canvas edge, where the blur fades towards the dark canvas.
        foreach (var (x, y, top) in new[] { (6, 6, true), (593, 6, true), (6, 593, false), (593, 593, false) })
        {
            var pixel = At(x, y, "backdrop-corner");
            var (main, other1, other2) = top ? (pixel.Red, pixel.Green, pixel.Blue) : (pixel.Blue, pixel.Red, pixel.Green);
            Assert.True(main > other1 + 15 && main > other2 + 15, $"backdrop corner ({x},{y}) keeps the poster's {(top ? "red" : "blue")}: {pixel}");
            Assert.True(main <= (top ? Darkened(Red).Red : Darkened(Blue).Blue) + 10, $"backdrop corner ({x},{y}) is darkened: {pixel}");
        }

        // Away from the corners, half way down each side's red and blue halves: the darkened poster colour.
        AssertNear(Darkened(Red), At(50, 150, "backdrop-red"), "darkened backdrop, red half");
        AssertNear(Darkened(Blue), At(550, 450, "backdrop-blue"), "darkened backdrop, blue half");

        // Darker than the poster: the backdrop's mean brightness is well under the fitted poster's.
        var backdrop = MeanLuma(actual, new SKRectI(0, 0, 100 - EdgeInset, 600));
        var fitted = MeanLuma(actual, new SKRectI(100 + EdgeInset, 0, 500 - EdgeInset, 600));
        samples.Add(FormattableString.Invariant($"mean-luma backdrop {backdrop:F1} poster {fitted:F1}"));
        Assert.True(backdrop < fitted * 0.7, FormattableString.Invariant($"backdrop {backdrop:F1} is not darker than the poster {fitted:F1}"));

        // Blurred: on the backdrop the red/blue seam is a gradient (sigma 24), not a step. At the seam itself both
        // colours mix; 20 px either side is still mixed; a sharp copy would be pure red/blue at all of these.
        var seam = At(50, 300, "backdrop-seam");
        Assert.InRange((int)seam.Red, 45, 100);
        Assert.InRange((int)seam.Blue, 45, 100);
        var above = At(50, 280, "backdrop-seam-20-above");
        var below = At(50, 320, "backdrop-seam-20-below");
        var sharpRedStep = Darkened(Red).Red - Darkened(Blue).Red;
        Assert.True(above.Red - below.Red < sharpRedStep * 0.8, $"backdrop step {above.Red - below.Red} is as sharp as the unblurred {sharpRedStep}");
        Assert.True(above.Red > below.Red, "the gradient runs from red above to blue below (not flipped)");

        Keep("square-single-blur", result.Jpeg, actual, null, samples);
    }

    [Fact]
    public void CropAndOrientationFollowThePosterAndInputOrderPicksTheCell()
    {
        // A wide poster (left half red, right half blue) in a tall cell: scaled to cover, the centred crop puts the seam in
        // the middle of the cell. A top-banded poster keeps its band at the top (no flip or rotation).
        var wide = Split(300, 100, Red, Blue);
        var topBand = Banded(342, 513, Yellow, Green, bandFraction: 0.25);
        var result = ListCollageRenderer.Render(new[] { wide, topBand }, ListCollageShape.Square);

        Assert.NotNull(result);
        using var actual = Decode(result!.Jpeg);
        var samples = new List<string>();
        void Expect(int x, int y, SKColor colour, string label)
        {
            var pixel = actual.GetPixel(x, y);
            samples.Add(Sample(label, x, y, colour, pixel));
            AssertNear(colour, pixel, label);
        }

        Expect(100, 300, Red, "wide poster: left of the seam");
        Expect(200, 300, Blue, "wide poster: right of the seam");
        Expect(110, 10, Red, "wide poster: top-left stays red");
        Expect(190, 590, Blue, "wide poster: bottom-right stays blue");

        // The 342x513 poster covering a 300x600 cell: scale 600/513, the full height shows, so the yellow quarter is the
        // top 150 px of the cell.
        Expect(450, 40, Yellow, "top band at the top");
        Expect(450, 560, Green, "rest below");

        // Swapping the inputs swaps the cells.
        var swapped = ListCollageRenderer.Render(new[] { topBand, wide }, ListCollageShape.Square);
        using var swappedImage = Decode(swapped!.Jpeg);
        AssertNear(Yellow, swappedImage.GetPixel(150, 40), "first input fills the left cell");
        AssertNear(Red, swappedImage.GetPixel(400, 300), "second input fills the right cell");
        Keep("crop-orientation", result.Jpeg, actual, null, samples);
    }

    [Fact]
    public void NoUsablePosterRendersNothing()
    {
        Assert.Null(ListCollageRenderer.Render(Array.Empty<byte[]>(), ListCollageShape.Square));
        Assert.Null(ListCollageRenderer.Render(Array.Empty<byte[]>(), ListCollageShape.Poster));
        Assert.Null(ListCollageRenderer.Render(new[] { Array.Empty<byte>(), new byte[] { 1, 2, 3 } }, ListCollageShape.Square));
        Assert.Null(ListCollageRenderer.Render(new[] { Truncated(Flat(Red)) }, ListCollageShape.Poster));
        Assert.Null(ListCollageRenderer.Render(new byte[]?[] { null }!, ListCollageShape.Poster));
    }

    [Fact]
    public void UndecodablePostersAreSkippedAndAtMostFourOfTheFirstEightInputsAreUsed()
    {
        var inputs = new[] { new byte[] { 9 }, Flat(Red), Truncated(Flat(Magenta)), Flat(Green), Flat(Blue), Flat(Yellow), Flat(Magenta) };
        var result = ListCollageRenderer.Render(inputs, ListCollageShape.Poster);

        Assert.NotNull(result);
        Assert.Equal(new[] { 1, 3, 4, 5 }, result!.UsedInputs);
        using var actual = Decode(result.Jpeg);
        AssertNear(Red, actual.GetPixel(100, 150), "first decodable");
        AssertNear(Green, actual.GetPixel(300, 150), "second decodable");
        AssertNear(Blue, actual.GetPixel(100, 450), "third decodable");
        AssertNear(Yellow, actual.GetPixel(300, 450), "fourth decodable");

        // Only the first eight inputs are looked at: eight unusable ones then a good one is no collage.
        var late = Enumerable.Repeat(new byte[] { 7 }, ListCollageRenderer.MaxInputs).Append(Flat(Red)).ToList();
        Assert.Null(ListCollageRenderer.Render(late, ListCollageShape.Square));
        Assert.Equal(8, ListCollageRenderer.MaxInputs);
        Assert.Equal(4, ListCollageRenderer.MaxPosters);
    }

    [Fact]
    public void SourcesAreDecodedStrictlyWithinPixelAspectAndByteBounds()
    {
        Assert.True(ListCollageRenderer.CanDecode(Flat(Red)));
        Assert.False(ListCollageRenderer.CanDecode(Truncated(Flat(Red))));
        Assert.False(ListCollageRenderer.CanDecode(Array.Empty<byte>()));

        // Aspect at most 4:1 either way.
        Assert.True(ListCollageRenderer.CanDecode(Flat(Red, 400, 100)));
        Assert.True(ListCollageRenderer.CanDecode(Flat(Red, 100, 400)));
        Assert.False(ListCollageRenderer.CanDecode(Flat(Red, 401, 100)));
        Assert.False(ListCollageRenderer.CanDecode(Flat(Red, 342, 1)));
        Assert.False(ListCollageRenderer.CanDecode(Flat(Red, 1, 342)));

        // More than 4096x4096 pixels is refused from the header, before any pixel memory is allocated.
        Assert.False(ListCollageRenderer.CanDecode(PngHeaderOnly(4097, 4097)));
        Assert.False(ListCollageRenderer.CanDecode(PngHeaderOnly(8192, 4096)));

        // At most 2 MiB of encoded input: a valid poster padded past it is not even looked at.
        var poster = Flat(Red);
        var padded = poster.Concat(new byte[ListCollageRenderer.MaxInputBytes - poster.Length + 1]).ToArray();
        Assert.True(ListCollageRenderer.CanDecode(poster.Concat(new byte[ListCollageRenderer.MaxInputBytes - poster.Length]).ToArray()));
        Assert.False(ListCollageRenderer.CanDecode(padded));
        Assert.Null(ListCollageRenderer.Render(new[] { padded }, ListCollageShape.Square));
        Assert.Equal(2 * 1024 * 1024, ListCollageRenderer.MaxInputBytes);
        Assert.Equal(4096L * 4096L, ListCollageRenderer.MaxSourcePixels);
    }

    [Fact]
    public void TheOutputIsAQuality90JpegOfTheListShape()
    {
        Assert.Equal((600, 600), ListCollageRenderer.SizeFor(ListCollageShape.Square));
        Assert.Equal((400, 600), ListCollageRenderer.SizeFor(ListCollageShape.Poster));
        Assert.Equal(ListCollageShape.Square, ListCollageRenderer.ShapeFor("playlist"));
        Assert.Equal(ListCollageShape.Poster, ListCollageRenderer.ShapeFor("collection"));
        Assert.Null(ListCollageRenderer.ShapeFor("folder"));
        Assert.Null(ListCollageRenderer.ShapeFor(null));

        var result = ListCollageRenderer.Render(new[] { Flat(Red) }, ListCollageShape.Poster)!;
        Assert.Equal(new byte[] { 0xFF, 0xD8, 0xFF }, result.Jpeg[..3]);
        using var codec = SKCodec.Create(new MemoryStream(result.Jpeg));
        Assert.Equal(SKEncodedImageFormat.Jpeg, codec.EncodedFormat);
        Assert.Equal(90, ListCollageRenderer.JpegQuality);

        // An unknown shape value is refused, not drawn at some default size.
        Assert.Throws<ArgumentOutOfRangeException>(() => ListCollageRenderer.Render(new[] { Flat(Red) }, (ListCollageShape)7));
        Assert.Throws<ArgumentOutOfRangeException>(() => ListCollageRenderer.SizeFor((ListCollageShape)7));
    }

    [Fact]
    public void EveryNativeResourceIsDisposedOnSuccessRefusalAndCancellation()
    {
        // Success.
        using (var trace = ListCollageRenderer.Trace())
        {
            Assert.NotNull(ListCollageRenderer.Render(new[] { Flat(Red), Flat(Green), Flat(Blue) }, ListCollageShape.Square));
            Assert.True(trace.CreatedCount > 0);
            Assert.Equal(trace.CreatedCount, trace.DisposedCount);
        }

        // One poster on a square (paint, blur filter, shade).
        using (var trace = ListCollageRenderer.Trace())
        {
            Assert.NotNull(ListCollageRenderer.Render(new[] { Flat(Red) }, ListCollageShape.Square));
            Assert.Equal(trace.CreatedCount, trace.DisposedCount);
        }

        // Refused inputs.
        using (var trace = ListCollageRenderer.Trace())
        {
            Assert.Null(ListCollageRenderer.Render(new[] { Truncated(Flat(Red)), Flat(Red, 342, 1), PngHeaderOnly(4097, 4097) }, ListCollageShape.Poster));
            Assert.True(trace.CreatedCount > 0);
            Assert.Equal(trace.CreatedCount, trace.DisposedCount);
        }

        // Cancelled after two posters were decoded: no result, nothing left undisposed.
        using (var cts = new CancellationTokenSource())
        using (var trace = ListCollageRenderer.Trace())
        {
            var stages = new List<string>();
            trace.OnStage = stage =>
            {
                stages.Add(stage);
                if (stage == "decoded:2")
                {
                    cts.Cancel();
                }
            };
            Assert.ThrowsAny<OperationCanceledException>(() => ListCollageRenderer.Render(new[] { Flat(Red), Flat(Green), Flat(Blue) }, ListCollageShape.Square, cts.Token));
            Assert.Contains("decoded:2", stages);
            Assert.DoesNotContain("encoded", stages);
            Assert.True(trace.CreatedCount > 0);
            Assert.Equal(trace.CreatedCount, trace.DisposedCount);
        }

        // Cancelled while drawing.
        using (var cts = new CancellationTokenSource())
        using (var trace = ListCollageRenderer.Trace())
        {
            trace.OnStage = stage =>
            {
                if (stage == "drawn")
                {
                    cts.Cancel();
                }
            };
            Assert.ThrowsAny<OperationCanceledException>(() => ListCollageRenderer.Render(new[] { Flat(Red) }, ListCollageShape.Square, cts.Token));
            Assert.Equal(trace.CreatedCount, trace.DisposedCount);
        }

        // Already cancelled: nothing is created.
        using (var trace = ListCollageRenderer.Trace())
        {
            Assert.ThrowsAny<OperationCanceledException>(() => ListCollageRenderer.Render(new[] { Flat(Red) }, ListCollageShape.Square, new CancellationToken(true)));
            Assert.Equal(0, trace.CreatedCount);
        }
    }

    [Fact]
    public void RenderingHasNoStateBetweenCalls()
    {
        // A render after a successful one with no usable poster is no collage, never the previous one.
        Assert.NotNull(ListCollageRenderer.Render(new[] { Flat(Red) }, ListCollageShape.Square));
        Assert.Null(ListCollageRenderer.Render(new[] { new byte[] { 1 } }, ListCollageShape.Square));

        // The same inputs give the same pixels.
        var first = ListCollageRenderer.Render(new[] { Flat(Red), Flat(Blue) }, ListCollageShape.Poster)!;
        var second = ListCollageRenderer.Render(new[] { Flat(Red), Flat(Blue) }, ListCollageShape.Poster)!;
        using var a = Decode(first.Jpeg);
        using var b = Decode(second.Jpeg);
        Assert.Equal(0.0, MeanAbsDiff(a, b, new SKRectI(0, 0, 400, 600)));
    }

    // ---- fixtures and checks ----------------------------------------------------------------------------------------

    private static byte[] Flat(SKColor color, int width = 342, int height = 513)
    {
        using var bitmap = new SKBitmap(width, height);
        bitmap.Erase(color);
        return EncodePng(bitmap);
    }

    private static byte[] Banded(int width, int height, SKColor top, SKColor bottom, double bandFraction = 0.5)
    {
        using var bitmap = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(bottom);
            using var paint = new SKPaint { Color = top };
            canvas.DrawRect(new SKRect(0, 0, width, (float)(height * bandFraction)), paint);
        }

        return EncodePng(bitmap);
    }

    private static byte[] Split(int width, int height, SKColor left, SKColor right)
    {
        using var bitmap = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(left);
            using var paint = new SKPaint { Color = right };
            canvas.DrawRect(new SKRect(width / 2f, 0, width, height), paint);
        }

        return EncodePng(bitmap);
    }

    private static byte[] EncodePng(SKBitmap bitmap)
    {
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static byte[] Truncated(byte[] bytes) => bytes[..(bytes.Length / 2)];

    // A PNG signature and IHDR claiming the given size, with no image data (the codec reads the size from the header).
    private static byte[] PngHeaderOnly(int width, int height)
    {
        var ihdr = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(0), width);
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), height);
        ihdr[8] = 8; // bit depth
        ihdr[9] = 2; // RGB
        using var stream = new MemoryStream();
        stream.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
        Chunk(stream, "IHDR", ihdr);
        Chunk(stream, "IEND", Array.Empty<byte>());
        return stream.ToArray();

        static void Chunk(Stream s, string type, byte[] data)
        {
            Span<byte> length = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(length, data.Length);
            s.Write(length);
            var typeAndData = Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
            s.Write(typeAndData);
            Span<byte> crc = stackalloc byte[4];
            BinaryPrimitives.WriteUInt32BigEndian(crc, Crc(typeAndData));
            s.Write(crc);
        }

        static uint Crc(byte[] bytes)
        {
            var crc = 0xFFFFFFFFu;
            foreach (var b in bytes)
            {
                crc ^= b;
                for (var k = 0; k < 8; k++)
                {
                    crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
                }
            }

            return ~crc;
        }
    }

    private static SKBitmap Decode(byte[] jpeg)
    {
        var bitmap = SKBitmap.Decode(jpeg);
        Assert.NotNull(bitmap);
        return bitmap;
    }

    private static SKColor Darkened(SKColor c) =>
        new((byte)Math.Round(c.Red * (1 - (115 / 255.0))), (byte)Math.Round(c.Green * (1 - (115 / 255.0))), (byte)Math.Round(c.Blue * (1 - (115 / 255.0))));

    private static void AssertNear(SKColor expected, SKColor actual, string what) =>
        Assert.True(
            Math.Abs(expected.Red - actual.Red) < PointTolerance && Math.Abs(expected.Green - actual.Green) < PointTolerance && Math.Abs(expected.Blue - actual.Blue) < PointTolerance,
            $"{what}: expected {expected}, got {actual}");

    private static SKRectI Inset(SKRectI r, int by) => new(r.Left + by, r.Top + by, r.Right - by, r.Bottom - by);

    private static double MeanAbsDiff(SKBitmap a, SKBitmap b, SKRectI area)
    {
        double sum = 0;
        long n = 0;
        for (var y = area.Top; y < area.Bottom; y += 2)
        {
            for (var x = area.Left; x < area.Right; x += 2)
            {
                var p = a.GetPixel(x, y);
                var q = b.GetPixel(x, y);
                sum += (Math.Abs(p.Red - q.Red) + Math.Abs(p.Green - q.Green) + Math.Abs(p.Blue - q.Blue)) / 3.0;
                n++;
            }
        }

        return n == 0 ? 0 : sum / n;
    }

    private static double MeanLuma(SKBitmap bitmap, SKRectI area)
    {
        double sum = 0;
        long n = 0;
        for (var y = area.Top; y < area.Bottom; y += 2)
        {
            for (var x = area.Left; x < area.Right; x += 2)
            {
                var p = bitmap.GetPixel(x, y);
                sum += (0.2126 * p.Red) + (0.7152 * p.Green) + (0.0722 * p.Blue);
                n++;
            }
        }

        return sum / n;
    }

    private static string Sample(string label, int x, int y, SKColor? expected, SKColor actual) =>
        string.Create(CultureInfo.InvariantCulture, $"{label} ({x},{y}) expected {(expected.HasValue ? expected.Value.ToString() : "-")} actual {actual}");

    // Keeps the rendered JPEG, a sheet (actual | reference | 4x diff) and the sampled values when asked to.
    private static void Keep(string name, byte[] jpeg, SKBitmap actual, SKBitmap? expected, IEnumerable<string> samples)
    {
        var dir = Environment.GetEnvironmentVariable("JE_COLLAGE_PIXEL_ARTIFACTS");
        if (string.IsNullOrEmpty(dir))
        {
            return;
        }

        Directory.CreateDirectory(dir);
        File.WriteAllBytes(Path.Combine(dir, name + ".jpg"), jpeg);
        File.WriteAllLines(Path.Combine(dir, name + ".samples.txt"), samples);
        var panels = expected == null ? 1 : 3;
        using var sheet = new SKBitmap((actual.Width * panels) + (8 * (panels - 1)), actual.Height);
        using (var canvas = new SKCanvas(sheet))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(actual, 0, 0);
            if (expected != null)
            {
                canvas.DrawBitmap(expected, actual.Width + 8, 0);
                using var diff = new SKBitmap(actual.Width, actual.Height);
                for (var y = 0; y < actual.Height; y++)
                {
                    for (var x = 0; x < actual.Width; x++)
                    {
                        var p = actual.GetPixel(x, y);
                        var q = expected.GetPixel(x, y);
                        diff.SetPixel(x, y, new SKColor(Amp(p.Red, q.Red), Amp(p.Green, q.Green), Amp(p.Blue, q.Blue)));
                    }
                }

                canvas.DrawBitmap(diff, (actual.Width + 8) * 2, 0);
            }
        }

        File.WriteAllBytes(Path.Combine(dir, name + ".sheet.png"), EncodePng(sheet));

        static byte Amp(byte a, byte b) => (byte)Math.Min(255, Math.Abs(a - b) * 4);
    }
}
