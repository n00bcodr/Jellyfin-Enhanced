#pragma warning disable ASPDEPR004, ASPDEPR008
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Dto;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationD46Round26ValueFactTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void VocabularyMemoReplaysItsProducerProofForPairsAndScalars(bool scalar)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var ep = rig.Items.Values.OfType<Episode>().First();
        var series = rig.Items[ep.SeriesId];
        series.Studios = ["allowed studio", "unused studio"];
        var host = new PrivacyValueHost(rig.Library.Object, rig.Localization);
        BaseItemDto Project() => PrivacyValues.Guarded(new BaseItemDto {
            Id=ep.Id, Type=BaseItemKind.Episode, SeriesId=ep.SeriesId,
            Studios=scalar ? null : [new NameGuidPair {Name="allowed studio",Id=Guid.NewGuid()}],
            SeriesStudio=scalar ? "allowed studio" : null
        }, PrivacyReveal.None, host);
        using (var cold = PrivacyReadSet.Begin())
        {
            Project(); Assert.True(cold.Reads.Valid());
            series.Studios=["allowed studio"];
            Assert.True(cold.Reads.Valid(), "An unconsumed entry is not a changed authorization");
        }
        series.Studios=[];
        using var warm=PrivacyReadSet.Begin();
        var projected=Project();
        Assert.Equal("allowed studio",scalar ? projected.SeriesStudio : Assert.Single(projected.Studios!).Name);
        Assert.False(warm.Reads.Valid(),"A fresh consumer cannot renew an old vocabulary memo's proof");
    }

    [Theory]
    [InlineData(PrivacyValueHost.TextMember.Name)]
    [InlineData(PrivacyValueHost.TextMember.SortName)]
    [InlineData(PrivacyValueHost.TextMember.OriginalTitle)]
    public void ConsumedEntityTextIsComparedWithoutBorrowingUnrelatedVocabulary(PrivacyValueHost.TextMember member)
    {
        using var rig=new PrivacyHostShapeModelTests.Rig();
        var movie=rig.Items.Values.OfType<MediaBrowser.Controller.Entities.Movies.Movie>().First();
        movie.Name="first name";movie.SortName="first sort";movie.OriginalTitle="first original";
        var host=new PrivacyValueHost(rig.Library.Object,rig.Localization);
        using var scope=PrivacyReadSet.Begin();
        Assert.NotNull(host.Text(movie.Id,member)); Assert.True(scope.Reads.Valid());
        movie.Studios=["unconsumed studio"];
        Assert.True(scope.Reads.Valid());
        if(member==PrivacyValueHost.TextMember.Name)movie.Name="changed";
        else if(member==PrivacyValueHost.TextMember.SortName)movie.SortName="changed";
        else movie.OriginalTitle="changed";
        Assert.False(scope.Reads.Valid());
    }

    [Fact]
    public void StudioVocabularyUsedToApproveProtectedTextIsComparedAtTheCommit()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var ep = rig.Items.Values.OfType<Episode>().First();
        var series = rig.Items[ep.SeriesId];
        const string title = "The finale reveal";
        series.Studios = [title];
        var host = new PrivacyValueHost(rig.Library.Object, rig.Localization);
        using var scope = PrivacyReadSet.Begin();
        var projected = PrivacyValues.Guarded(new BaseItemDto {
            Id = ep.Id, Type = BaseItemKind.Episode, SeriesId = ep.SeriesId,
            Name = title, Studios = [new NameGuidPair { Name = title, Id = Guid.NewGuid() }],
        }, PrivacyReveal.None, host);
        Assert.Equal(title, Assert.Single(projected.Studios!).Name);
        Assert.True(scope.Reads.Valid());
        series.Studios = [];
        Assert.False(scope.Reads.Valid(), "The series studio that approved the protected text changed, but the set still holds");
    }
}
