using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using R = JE.Tests.IntegrationEditionAvailabilityTests;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// Edition round 19, part A (D53: projection keeps complete ownership and edition context). The copies that qualify for an
/// edition (what plays it) are kept apart from the evidence that decides which arr copy is whose (every copy, the ones the
/// viewer can't open included): a hidden or uncertain copy never turns its arr copy into "nobody's", so its downloads are
/// never told to someone who can't open it. A movie copy belongs to the Radarr whose folder it is in, and a library several
/// Radarrs link proves nothing. A season's request states are read in the edition of the control they sit on.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionOwnershipTests
{
    private static readonly TitleKey Movie = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Tv = TitleKey.Parse("tv:tvdb:78874")!;

    /// <summary>The 4K copy is one only the administrator may open (a parental limit hides it from the kid).</summary>
    private static (StatusViewer Kid, Guid Hidden) HideFourK(R.Rig rig, TitleKey key)
    {
        var kid = rig.View.AddUser(false, parental: true);
        var list = rig.View.CopiesByKey[key.ToString()];
        var n = list.FindIndex(x => x.Copy.ItemId == rig.UhdCopy);
        list[n] = (list[n].Copy, new HashSet<Guid> { rig.Admin.UserId });
        rig.View.Items[rig.UhdCopy] = rig.View.Items[rig.UhdCopy] with { VisibleTo = new HashSet<Guid> { rig.Admin.UserId } };
        Assert.Null(rig.View.Resolve(rig.UhdCopy, kid));
        return (kid, rig.UhdCopy);
    }

    // ------------------------------------------------------------------ ED-AX-1: a hidden copy is never nobody's

    [Fact]
    public async Task AFourKMovieRequestNeverShowsTheDownloadOfACopyTheViewerCantOpen()
    {
        using var rig = new R.Rig(R.Layout.SeparateLibraries, R.Has.Both, true);
        var (kid, _) = HideFourK(rig, Movie);
        rig.Radarr4k!.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        var result = await rig.Requested(R.Part.Movie, true, kid);
        Assert.True(result.Status.Stage != StatusStage.Downloading && result.Status.Progress == null,
            $"the kid's 4K request: {result.Status.Stage}/{result.Status.Reason.Code} {result.Status.Progress?.Percent}");
        // Control: the administrator, who opens the 4K copy, sees its download (an upgrade under way, or the download).
        var admin = await rig.Requested(R.Part.Movie, true, rig.Admin);
        Assert.NotNull(admin.Status.Progress);
    }

    [Fact]
    public async Task AFourKSeasonRequestNeverBindsTheFourKSonarrAsNobodysWhileAHiddenCopyMayBeIts()
    {
        using var rig = new R.Rig(R.Layout.SeparateLibraries, R.Has.Both, false);
        var (kid, _) = HideFourK(rig, Tv);
        // Sonarr 4K may hold the hidden copy, but its folder can't be matched to the Jellyfin folder.
        rig.Sonarr4k!.Series[0]["path"] = "/different/Firefly";
        rig.Sonarr4k.Queue.Add(FakeArr.SonarrQueueRow(102, "uhd-private", 1, 2, "Firefly", 78874));
        await rig.Service.ComposeForAsync(kid, new[] { Tv }, null, default, loadEpisodes: true);
        await Task.Delay(30);
        var whole = Assert.Single(await rig.Service.ComposeForAsync(kid, new[] { Tv }, null, default, loadEpisodes: true));
        Assert.NotEqual(StatusStage.Downloading, whole.Status.Stage);
        var scoped = await rig.Requested(R.Part.Season, true, kid);
        Assert.True(scoped.Status.Stage != StatusStage.Downloading && scoped.Status.Progress == null,
            $"the kid's 4K season request: {scoped.Status.Stage}/{scoped.Status.Reason.Code}");
    }

    // ------------------------------------------------------------------ ED-AX-5: a movie copy is its own Radarr's

    [Theory]
    [InlineData("exact folder")]   // each copy sits in its own Radarr's folder: that decides, whatever the libraries say
    [InlineData("no folder tells")] // the 4K Radarr's folder is elsewhere: a library both Radarrs link proves nothing
    public async Task AMoviePageNeverBorrowsAnotherRadarrsDownloadWhenBothLinkItsLibrary(string folders)
    {
        using var rig = new R.Rig(R.Layout.SeparateLibraries, R.Has.Both, true);
        var library = Guid.NewGuid().ToString("N");
        var list = rig.View.CopiesByKey[Movie.ToString()];
        for (var i = 0; i < list.Count; i++)
        {
            var c = list[i].Copy;
            list[i] = (new JfCopy { ItemId = c.ItemId, Path = c.Path, LibraryId = library, LibraryName = "Movies", DateCreated = c.DateCreated }, list[i].VisibleTo);
        }
        var config = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(config.RadarrInstances)!.AsArray();
        foreach (var row in rows) row!["LinkedLibraryIds"] = new JsonArray(library);
        config.RadarrInstances = rows.ToJsonString();
        if (folders == "no folder tells") rig.Radarr4k!.Movies[0]["path"] = "/data/elsewhere/Sintel (2010)";
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        var page = await M.Page(rig, rig.Member, rig.UhdCopy);
        Assert.True(page.GetProperty("reason").GetProperty("code").GetString() != "upgrading" && !page.TryGetProperty("progress", out _),
            $"the 4K copy's page: {page}");
        // Control: the standard copy's page shows its own Radarr's download (a better copy coming).
        var standard = await M.Page(rig, rig.Member, rig.HdCopy);
        Assert.Equal("upgrading", standard.GetProperty("reason").GetProperty("code").GetString());
    }

    // ------------------------------------------------------------------ ED-AX-6: request states in the control's own edition

    [Fact]
    public async Task SeasonRowsGiveEachEditionsRequestStatesSoAFourKControlReadsFourKAsks()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        r.Policy.People[r.Kid] = r.Policy.People[r.Kid] with { Can4k = true };
        var season = Guid.NewGuid(); var series = Guid.NewGuid();
        r.View.AddItem(new JfItemRef { ItemId = season, Kind = "season", Key = Tv.WithSeason(1), SeriesId = series, Season = 1, TmdbId = 1437, Path = "/media/tv4k/Firefly/Season 1" });
        MutationInput Ask(int ep, string variant) => new() { Key = Tv.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, ep) }, Variant = variant };
        Assert.Equal(201, (await r.Create(r.Kid, Ask(2, "standard"))).HttpStatus);
        Assert.Equal(201, (await r.Create(r.Kid, Ask(4, "4k"))).HttpStatus);
        var service = new SeasonRowsService(r.View, r.Ledger, r.Policy, null, (_, _, _, _) => Task.FromResult<string?>("{\"episodes\":[{\"episode_number\":2},{\"episode_number\":4}]}"), () => r.Now);
        var rows = JsonSerializer.SerializeToElement(await service.ForSeasonAsync(r.View.Users[r.Kid], season, null, default));
        JsonElement Row(int n) => rows.GetProperty("episodes").EnumerateArray().Single(e => e.GetProperty("episode").GetInt32() == n);
        string? State(int n, string property) => Row(n).TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        // The standard controls read the standard asks (as before) ...
        Assert.Equal(("waiting", (string?)null), (State(2, "request"), State(4, "request")));
        // ... and a 4K control reads the 4K asks: E4 waits for an OK in 4K, E2's standard ask says nothing of 4K.
        Assert.Equal(((string?)null, "waiting"), (State(2, "request4k"), State(4, "request4k")));
    }
}
