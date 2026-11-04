using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;

namespace JE.Tests;

/// <summary>Numbers read left to right on native posters in every script, as browsers draw them (Unicode bidi).</summary>
public class PosterTextDirectionTests
{
    [Theory]
    [InlineData("٧٫٥")]   // Arabic-Indic 7.5
    [InlineData("۸۱٪")]   // Persian 81%
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
        // Positions increase left to right with the logical order.
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
