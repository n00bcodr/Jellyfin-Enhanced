using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using User = Jellyfin.Database.Implementations.Entities.User;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

/// <summary>
/// The one surface registry against the hosts' real endpoints (tests/fixtures/host-endpoints) and the model's own
/// independent classification.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacySurfaceRegistryTests
{
    private static string Key(PrivacySurface e) => e.Controller + "." + e.Action;

    [Fact]
    public void EveryTitleCarryingEndpointOfBothHostsIsClassified()
    {
        var registered = PrivacySurfaceRegistry.Entries.Select(Key).ToHashSet();
        foreach (var host in new[] { "12.2", "10.11.11" })
        {
            var missing = PrivacySurfaceModelTests.HostEndpoints.Where(e => e.Host == host && e.TitlePath.Length > 0)
                .Select(e => e.Controller + "." + e.Action).Where(k => !registered.Contains(k)).ToArray();
            Assert.True(missing.Length == 0, host + " unclassified: " + string.Join(", ", missing));
        }
    }

    [Fact]
    public void TheRegistryListsOnlyRealEndpoints()
    {
        var host = PrivacySurfaceModelTests.TitleEndpoints.Keys.ToHashSet();
        var extra = PrivacySurfaceRegistry.Entries.Select(Key).Where(k => !host.Contains(k) && k != "HomeScreen.GetSectionContent").ToArray();
        Assert.True(extra.Length == 0, "not a title endpoint of either host: " + string.Join(", ", extra));
        Assert.Equal(PrivacySurfaceRegistry.Entries.Count, PrivacySurfaceRegistry.Entries.Select(Key).Distinct().Count());
    }

    [Fact]
    public void TheRegistryAgreesWithTheModelsIndependentClassification()
    {
        foreach (var entry in PrivacySurfaceRegistry.Entries)
        {
            var (hc, sg) = PrivacySurfaceModelTests.Expected(Key(entry));
            Assert.True((entry.Hc is "items" or "home-sections" ? "library" : entry.Hc) == hc && entry.Sg == sg, Key(entry));
            Assert.True(entry.Hc != null || !string.IsNullOrEmpty(entry.HcExempt), Key(entry) + " needs a Hidden Content exemption reason");
            Assert.True(entry.Sg || !string.IsNullOrEmpty(entry.SgExempt), Key(entry) + " needs a Spoiler Guard exemption reason");
        }
    }

    [Theory]
    [InlineData(typeof(QueryResult<BaseItemDto>), true)]
    [InlineData(typeof(List<RecommendationDto>), true)]
    [InlineData(typeof(SearchHintResult), true)]
    [InlineData(typeof(PlaybackInfoResponse), true)]
    [InlineData(typeof(List<ImageInfo>), true)]
    [InlineData(typeof(AllThemeMediaResult), true)]
    [InlineData(typeof(List<SessionInfoDto>), true)]
    [InlineData(typeof(UserItemDataDto), false)]
    [InlineData(typeof(QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>), false)]
    [InlineData(typeof(string), false)]
    public void TheRuntimeTitleWalkMatchesTheHostExtraction(Type type, bool carries)
        => Assert.Equal(carries, PrivacySurfaceRegistry.CarriesTitles(type));
}
