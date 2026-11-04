using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;

namespace JE.Tests;

/// <summary>Tag text reads in the order browsers draw it (Unicode bidi, paragraph direction from the first strong letter).</summary>
public class PosterTextDirectionTests
{
    /// <summary>Characters of <paramref name="text"/> left to right on screen (a right-to-left run reversed).</summary>
    private static string Visual(string text) => string.Concat(PosterTagBidi.VisualRuns(text).Select(run =>
    {
        var part = text.Substring(run.Start, run.Length);
        return run.Rtl ? new string(part.Reverse().ToArray()) : part;
    }));

    [Theory]
    [InlineData("7.5", "7.5")]
    [InlineData("Airs Nov 6", "Airs Nov 6")]
    [InlineData("٧٫٥", "٧٫٥")]                 // Arabic-Indic 7.5: a number keeps its digit order
    [InlineData("۸۱٪", "۸۱٪")]                 // Persian 81%
    [InlineData("שלום 12", "12 םולש")]          // RTL paragraph: the number sits at the left, read left to right
    [InlineData("HDR שלום", "HDR םולש")]        // LTR paragraph: the Hebrew word reads right to left
    [InlineData("يعرض ٥/١١", "٥/١١ ضرعي")]     // an Arabic date stays day/month in order
    [InlineData("פרק (12)", ")12( קרפ")]        // brackets resolve with the Hebrew around them (mirrored when drawn)
    [InlineData("שלום HDR 4K", "HDR 4K םולש")]  // a Latin phrase inside RTL text keeps its own order
    public void RunsComeBackInVisualOrder(string text, string visual) => Assert.Equal(visual, Visual(text));

    [Theory]
    [InlineData("٧٫٥")]
    [InlineData("۸۱٪")]
    [InlineData("٨٫١")]
    [InlineData("7.5")]
    public void NumbersKeepTheirDigitOrder(string text)
    {
        using var assets = PosterTagAssets.Load();
        using var layout = new PosterTagText(assets.TextTypeface);
        var runs = layout.Layout(text, 12, false, 0).Runs;
        var glyphs = runs.SelectMany(run => run.Glyphs).ToArray();
        if (runs.Count == 1) Assert.Equal(runs[0].Typeface.GetGlyphs(text), glyphs);
        else Assert.Equal(text.Length, glyphs.Length);
        var positions = runs.SelectMany(run => run.Positions).ToArray();
        Assert.Equal(positions.OrderBy(p => p), positions);
    }

    [Fact]
    public void MixedHebrewAndNumbersDrawInVisualOrder()
    {
        using var assets = PosterTagAssets.Load();
        using var layout = new PosterTagText(assets.TextTypeface);
        const string text = "שלום 12";
        var runs = layout.Layout(text, 12, false, 0).Runs;
        // Each visual character's glyph from the face the layout used: the primary face where it has the glyph.
        var faces = runs.Select(run => run.Typeface).Distinct().OrderBy(face => ReferenceEquals(face, assets.TextTypeface) ? 0 : 1).ToArray();
        var expected = Visual(text).Select(c => faces.First(face => face.ContainsGlyph(c)).GetGlyphs(c.ToString())[0]).ToArray();
        Assert.Equal(expected, runs.SelectMany(run => run.Glyphs).ToArray());
        var positions = runs.SelectMany(run => run.Positions).ToArray();
        Assert.Equal(positions.OrderBy(p => p), positions);
    }

    [Fact]
    public void RightToLeftWordsStayRightToLeft()
    {
        using var assets = PosterTagAssets.Load();
        using var layout = new PosterTagText(assets.TextTypeface);
        const string word = "שלום"; // Hebrew letters do not join, so one glyph per letter
        var run = Assert.Single(layout.Layout(word, 12, false, 0).Runs);
        Assert.Equal(run.Typeface.GetGlyphs(word).Reverse(), run.Glyphs);
    }
}
