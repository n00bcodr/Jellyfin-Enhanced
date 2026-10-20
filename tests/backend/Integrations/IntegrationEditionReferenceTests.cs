using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// Edition round 16 (D53: one item reference carries every fact; the binding is verified for every transport). The
/// item a page, a card, an arrival or a queued download is judged by says whether Jellyfin plays it (a stub such as a
/// ".disc" file is listed, but plays nothing), exactly as the season rows' episodes do. A copy-qualified ask is offered
/// only where the request lands on that copy: in Seerr mode, only when Seerr's own default server for that edition is
/// that copy's Sonarr.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionReferenceTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    // ------------------------------------------------------------------ ED-R16-1: playability on the item reference

    /// <summary>The 4K folder's E3 is a stub (Jellyfin lists it, it plays nothing); its Sonarr has no file for it.</summary>
    private static (Rig Rig, Guid Stub, Guid Real) StubIn4k()
    {
        var rig = M.OneLibrary(grouped: false);
        rig.Sonarr4k!.Episodes.Add(M.Aired(103, 3));
        var stub = rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, null, null, rig.Now.AddDays(-1));
        rig.View.Placeholders.Add(stub);
        rig.View.Rev++;
        var real = rig.View.EpisodesBySeries[rig.UhdCopy].Single(x => x.Episode.Episode == 1).Episode.ItemId;
        return (rig, stub, real);
    }

    private static async Task<JsonElement> Card(Rig rig, StatusViewer viewer, Guid id)
    {
        await rig.Service.ForBatchAsync(viewer, new[] { id }, Array.Empty<TitleKey>(), default);
        await Task.Delay(20);
        return Assert.Single(M.Items(await rig.Service.ForBatchAsync(viewer, new[] { id }, Array.Empty<TitleKey>(), default)));
    }

    private static string Stage(JsonElement status) => status.GetProperty("stage").GetString()!;

    [Theory]
    [InlineData("page")]    // the finding: the stub's own episode page read Ready while its season row read looking
    [InlineData("card")]    // its card (the batch route resolves the same item)
    [InlineData("upgrade")] // a download of it is that episode coming, never "a better copy coming" of something it plays
    [InlineData("arrival")] // the arrival hand-off (and notifications' item) never names a stub as the episode that came
    [InlineData("movie")]   // the same reference of a movie: a stub movie's own page reads where Radarr has got to
    public async Task AStubReadsAsTheEpisodeItIsNotOnEverySurfaceThatReadsTheItem(string surface)
    {
        var (rig, stub, real) = StubIn4k();
        using var _ = rig;
        switch (surface)
        {
            case "page":
            {
                var page = await M.Page(rig, rig.Member, stub);
                Assert.True(Stage(page) != StatusStage.Ready, $"the stub's episode page {page}");
                Assert.Equal(StatusStage.Ready, Stage(await M.Page(rig, rig.Member, real)));
                break;
            }
            case "card":
            {
                var card = await Card(rig, rig.Member, stub);
                Assert.True(Stage(card) != StatusStage.Ready, $"the stub's card {card}");
                Assert.Equal(StatusStage.Ready, Stage(await Card(rig, rig.Member, real)));
                break;
            }
            case "upgrade":
            {
                rig.Sonarr4k!.Queue.Add(FakeArr.SonarrQueueRow(103, "uhd103", 1, 3, "Firefly", 78874));
                var page = await M.Page(rig, rig.Member, stub);
                Assert.True(Stage(page) == StatusStage.Downloading, $"a download of the stub's episode {page}");
                break;
            }
            case "movie":
            {
                using var movie = new Rig(IntegrationEditionAvailabilityTests.Layout.SeparateLibraries, IntegrationEditionAvailabilityTests.Has.Hd, movie: true);
                movie.Radarr.Movies[0]["hasFile"] = false;
                Assert.Equal(StatusStage.Ready, Stage(await M.Page(movie, movie.Member, movie.HdCopy)));
                movie.View.Placeholders.Add(movie.HdCopy);
                movie.View.Rev++;
                var page = await M.Page(movie, movie.Member, movie.HdCopy);
                Assert.True(Stage(page) != StatusStage.Ready, $"the stub movie's page {page}");
                break;
            }
            default:
            {
                var key = Firefly.WithEpisode(1, 3);
                Assert.Null(rig.Service.ArrivedItem(rig.Member, key, null, rig.UhdCopy));
                Assert.Equal(real, rig.Service.ArrivedItem(rig.Member, Firefly.WithEpisode(1, 1), null, rig.UhdCopy));
                break;
            }
        }
    }

    // ------------------------------------------------------------------ ED-R16-2: the binding is verified for the Seerr transport

    /// <summary>
    /// The service over <paramref name="rig"/> with Seerr's servers read through <paramref name="seerr"/> (a build without
    /// that seam: the rig's own service, which knows nothing of Seerr's servers).
    /// </summary>
    private static ArrStatusService WithSeerr(Rig rig, SeerrBackend seerr)
    {
        Func<PluginConfiguration?> config = () => rig.Arr.Plugin.Plugin.Configuration;
        Func<DateTimeOffset> now = () => rig.Arr.Now;
        var ctor = typeof(ArrStatusService).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
            .FirstOrDefault(c => c.GetParameters().Any(p => p.ParameterType != typeof(object) && p.ParameterType.IsAssignableFrom(typeof(SeerrBackend))));
        if (ctor == null) return rig.Service;
        var args = ctor.GetParameters().Select(p => p.ParameterType != typeof(object) && p.ParameterType.IsAssignableFrom(typeof(SeerrBackend)) ? seerr : p.Name switch
        {
            "store" => rig.Store,
            "view" => rig.View,
            "requests" => new NoRequestFacts(),
            "config" => config,
            "now" => now,
            _ => p.HasDefaultValue ? p.DefaultValue : null,
        }).ToArray();
        return (ArrStatusService)ctor.Invoke(args);
    }

    private static async Task<JsonElement> Page(ArrStatusService service, StatusViewer viewer, Guid id)
    {
        await service.ForItemAsync(viewer, id, default);
        await Task.Delay(20);
        return Assert.Single(M.Items(await service.ForItemAsync(viewer, id, default)));
    }

    private static JsonElement? CopyOf(JsonElement season) => season.TryGetProperty("copy", out var copy) ? copy : null;

    [Theory]
    [InlineData("this copy")]   // control: Seerr's default 4K Sonarr is the 4K copy's: "Get them in 4K" lands there
    [InlineData("another 4K")]  // the finding: Seerr's default 4K Sonarr is another server; the ask would land there
    [InlineData("unreadable")]  // Seerr's servers can't be read (a key that isn't an administrator's): nothing is proven
    [InlineData("no 4K")]       // Seerr has no 4K Sonarr: a 4K request reaches no copy
    public async Task ASeerrModeAskIsBoundToTheCopyOnlyWhereSeerrSendsIt(string seerrSide)
    {
        using var rig = M.OneLibrary(grouped: true);
        rig.Sonarr.Episodes.Add(M.Aired(103, 3));
        rig.Sonarr4k!.Episodes.Add(M.Aired(103, 3));
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, 3840, 2160, rig.Now.AddDays(-1));
        rig.Sonarr4k.Episodes.Single(e => (int)e["id"]! == 103)["hasFile"] = true;
        var config = rig.Arr.Plugin.Plugin.Configuration;
        config.ArrRequestBackend = "seerr";
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = FakeSeerr.Url;
        config.JellyseerrApiKey = FakeSeerr.Key;
        using var fake = new FakeSeerr();
        var standard = FakeSeerr.Server(0, "sonarr.lan", 8989, is4k: false, isDefault: true);
        fake.SonarrServers = seerrSide switch
        {
            "this copy" => new JsonArray(standard, FakeSeerr.Server(1, "sonarr4k.lan", 8989, is4k: true, isDefault: true)),
            "another 4K" => new JsonArray(standard, FakeSeerr.Server(1, "sonarr4k.lan", 8989, is4k: true, isDefault: false), FakeSeerr.Server(2, "sonarr4k-b.lan", 8989, is4k: true, isDefault: true)),
            "no 4K" => new JsonArray(standard),
            _ => null,
        };
        var model = new SeerrRequestReadModel(fake.Transport, null, null, () => config, () => rig.Arr.Now);
        var service = WithSeerr(rig, new SeerrBackend(fake.Transport, model, null, () => config, () => rig.Arr.Now));

        var fourK = CopyOf(await Page(service, rig.Member, M.SeasonPage(rig, rig.UhdCopy)));
        var reaches = seerrSide == "this copy";
        Assert.True(fourK is { } k && k.GetProperty("role").GetString() == "4k" && k.GetProperty("ask").GetBoolean() == reaches && !k.GetProperty("search").GetBoolean(),
            $"Seerr {seerrSide}: 4K page copy {fourK?.ToString() ?? "(none)"}");

        // The standard copy: Seerr's default standard Sonarr is its own (when Seerr's servers can be read at all).
        var std = CopyOf(await Page(service, rig.Member, M.SeasonPage(rig, rig.HdCopy)));
        var proven = seerrSide != "unreadable";
        Assert.True(std is { } s && s.GetProperty("ask").GetBoolean() == proven && s.GetProperty("search").GetBoolean() == proven,
            $"Seerr {seerrSide}: standard page copy {std?.ToString() ?? "(none)"}");
    }
}
