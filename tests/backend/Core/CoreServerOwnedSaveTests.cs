using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace JE.Tests;

/// <summary>
/// A configuration page save and the server's own writes to the household and request-handling settings: an edit that
/// lands between the page's read and its save survives the save.
/// </summary>
[Collection("Plugin singleton")]
public class CoreServerOwnedSaveTests
{
    private static PluginConfiguration Copy(PluginConfiguration config)
    {
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var writer = new StringWriter();
        serializer.Serialize(writer, config);
        using var reader = new StringReader(writer.ToString());
        return (PluginConfiguration)serializer.Deserialize(reader)!;
    }

    [Fact]
    public void AHouseholdEditOrMoveInTheGapBeforeAPageSaveIsKeptWhileThePagesOwnChangesWin()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        plugin.Configuration.ArrRequestUsers = "{\"kid\":{\"Role\":\"Member\"}}";
        plugin.Configuration.ArrRequestBackend = "seerr";
        plugin.Configuration.ArrRequestPreset = "ask_first";
        plugin.Configuration.ArrRequestQuotaLimit = 0;

        // The page reads the configuration just before saving...
        var page = Copy(plugin.Configuration);
        page.ArrServerOwnedSeen = "{\"ArrRequestUsers\":\"{\\\"kid\\\":{\\\"Role\\\":\\\"Member\\\"}}\",\"ArrRequestBackend\":\"seerr\",\"ArrRequestPreset\":\"ask_first\",\"ArrRequestQuotaLimit\":\"0\"}";
        page.ArrRequestPreset = "open_house";      // changed on the page
        page.ArrRequestStaleDays = 45;            // an unrelated setting
        // ...and before its save lands, the Household tab makes the child a Kid with a limit and a move switches handling.
        plugin.Configuration.ArrRequestUsers = "{\"kid\":{\"Role\":\"Kid\"}}";
        plugin.Configuration.ArrRequestQuotaLimit = 3;
        plugin.Configuration.ArrRequestBackend = "je";

        plugin.UpdateConfiguration(page);

        var live = plugin.Configuration;
        Assert.Equal("{\"kid\":{\"Role\":\"Kid\"}}", live.ArrRequestUsers);
        Assert.Equal(3, live.ArrRequestQuotaLimit);
        Assert.Equal("je", live.ArrRequestBackend);
        Assert.Equal("open_house", live.ArrRequestPreset);
        Assert.Equal(45, live.ArrRequestStaleDays);
        Assert.Equal(string.Empty, live.ArrServerOwnedSeen);   // never kept
    }

    [Fact]
    public void ASaveWithoutThePagesReadIsSavedAsPosted()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        plugin.Configuration.ArrRequestUsers = "{\"kid\":{\"Role\":\"Kid\"}}";
        var client = Copy(plugin.Configuration);
        client.ArrRequestUsers = "{}";
        client.ArrServerOwnedSeen = "not json";

        plugin.UpdateConfiguration(client);

        Assert.Equal("{}", plugin.Configuration.ArrRequestUsers);
        Assert.Equal(string.Empty, plugin.Configuration.ArrServerOwnedSeen);
    }
}
