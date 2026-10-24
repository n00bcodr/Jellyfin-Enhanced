using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities.TV;
using Newtonsoft.Json;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationD46TagInputsTests
{
    [Theory]
    [InlineData("name")]
    [InlineData("genres")]
    [InlineData("score")]
    public void SelectedTagConstructionValueIsComparedWithoutAnItemEvent(string field)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var item = rig.Items.Values.OfType<Series>().First();
        item.Name = "first title"; item.Genres = ["first genre"]; item.CommunityRating = 5;
        var request = new PrivacyTagDataRequest(null, null, null, _ => null, _ => false);
        using var reads = PrivacyReadSet.Begin();
        var answer = PrivacyValues.TagData(item, SpoilerTagDataStub.None, request, new PrivacyValueHost(rig.Library.Object, rig.Localization));
        var frozen = JsonConvert.SerializeObject(answer);
        Assert.True(reads.Reads.Valid(), reads.Reads.Failure);
        switch (field)
        {
            case "name": item.Name = "next title"; break;
            case "genres": item.Genres[0] = "next genre"; break;
            case "score": item.CommunityRating = 9; break;
        }
        Assert.Equal(frozen, JsonConvert.SerializeObject(answer));
        Assert.False(reads.Reads.Valid());
    }

    [Fact]
    public void AKeptEntityCannotSubstituteItsOwnTagVocabularyForTheCanonicalItem()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var item = rig.Items.Values.OfType<Series>().First();
        item.Genres = ["current genre"];
        var stale = new Series { Id=item.Id, Genres=["other viewer private genre"], Name="other private title" };
        using var reads = PrivacyReadSet.Begin();
        var answer = PrivacyValues.TagData(stale, SpoilerTagDataStub.None,
            new PrivacyTagDataRequest(null, null, null, _ => null, _ => false), new PrivacyValueHost(rig.Library.Object, rig.Localization));
        var json = JsonConvert.SerializeObject(answer);
        Assert.DoesNotContain("other viewer private genre", json);
        Assert.Contains("current genre", json);
        Assert.True(reads.Reads.Valid(), reads.Reads.Failure);
    }

    [Fact]
    public void RepresentativeSelectionAndItsNegativeResultAreRechecked()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var series = rig.Items.Values.OfType<Series>().First();
        var episode = rig.Items.Values.OfType<Episode>().First();
        Episode? pick = null;
        var request = new PrivacyTagDataRequest(null, null, null, _ => pick, _ => false);
        using var reads = PrivacyReadSet.Begin();
        PrivacyValues.TagData(series, SpoilerTagDataStub.None, request, new PrivacyValueHost(rig.Library.Object, rig.Localization));
        Assert.True(reads.Reads.Valid(), reads.Reads.Failure);
        pick = episode;
        Assert.False(reads.Reads.Valid());
    }
}
