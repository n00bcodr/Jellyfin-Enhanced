using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// Where a request would land, for the approval cards (<see cref="RequestPlaces"/>): the drive of the
/// title's own folder, the named folder or the instance's only root folder, named by its Jellyfin
/// library (never a path), and a 4K copy already held by a 4K instance. Uses the plugin singleton's
/// configuration (the instance list), so it runs in that collection.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationRequestPlacesTests
{
    [Fact]
    public async Task PlacesComeFromTheTitlesFolderOrTheRootFolderAndNameTheJellyfinLibraryNeverAPath()
    {
        const long Gb = 1_000_000_000;
        using var arr = new FakeArr();
        var radarr = arr.Add("radarr.invalid", "Radarr");
        var radarr4k = arr.Add("radarr4k.invalid", "Radarr");
        arr.Configure(("Radarr", ArrKind.Radarr, "http://radarr.invalid", "key-1"),
            ("Radarr 4K", ArrKind.Radarr, "http://radarr4k.invalid", "key-2"));
        var c = arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(c.RadarrInstances)!.AsArray();
        foreach (var row in rows) if ((string?)row!["Name"] == "Radarr 4K") row["Role"] = "4k";
        c.RadarrInstances = rows.ToJsonString();
        c.ArrIntegrationEnabled = true;
        c.ArrPhase1Enabled = true;
        radarr.Movies.Add(FakeArr.Movie(1, 603, "Toy Story", hasFile: false, path: "/data/movies/Toy Story (1995)"));
        radarr.DiskSpace.Add(new JsonObject { ["path"] = "/data", ["freeSpace"] = 1234 * Gb, ["totalSpace"] = 4000 * Gb });
        radarr.RootFolders.Add(new JsonObject { ["path"] = "/data/movies", ["freeSpace"] = 1234 * Gb, ["accessible"] = true });
        radarr4k.Movies.Add(FakeArr.Movie(9, 603, "Toy Story", hasFile: true, path: "/uhd/Toy Story (1995)"));
        radarr4k.RootFolders.Add(new JsonObject { ["path"] = "/uhd", ["freeSpace"] = 50 * Gb, ["accessible"] = true });
        using var store = arr.Store();
        var access = new FakeLibraryAccess();
        access.AddLibrary("Movies", "movies", "/data/movies");
        access.AddLibrary("Movies 4K", "movies", "/uhd");
        var places = new RequestPlaces(store, new ArrInstanceLibraries(store, access));
        var standard = arr.Instance("Radarr");
        var uhd = arr.Instance("Radarr 4K");
        foreach (var instance in new[] { standard, uhd })
        {
            await store.GetLibraryAsync(instance, default);
        }
        // No disk facts in memory yet: one read of the instance's system facts answers the space.
        Assert.Equal(1234 * Gb, (await places.PlaceAsync(standard.Id, null, "movie:tmdb:603", default))!.FreeBytes);
        await store.GetSystemAsync(uhd, default);

        // Held already: its own folder's drive; the Jellyfin library is named, never the folder.
        Assert.Equal(new RequestPlace("Movies", 1234 * Gb), await places.PlaceAsync(standard.Id, null, "movie:tmdb:603", default));
        // Not held: the instance's only root folder.
        Assert.Equal(new RequestPlace("Movies", 1234 * Gb), await places.PlaceAsync(standard.Id, null, "movie:tmdb:999", default));
        // A named folder of the 4K instance: its own free space.
        Assert.Equal(new RequestPlace("Movies 4K", 50 * Gb), await places.PlaceAsync(uhd.Id, "/uhd", "movie:tmdb:999", default));
        Assert.Null(await places.PlaceAsync("no-such-instance", null, "movie:tmdb:603", default));
        // A 4K copy with a file is here (named for administrators); none for a title the 4K instance lacks.
        Assert.Equal("Radarr 4K", places.FourKHolder("movie:tmdb:603"));
        Assert.Null(places.FourKHolder("movie:tmdb:999"));
        Assert.Null(places.FourKHolder("not a key"));
    }
}
