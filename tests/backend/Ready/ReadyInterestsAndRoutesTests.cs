using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Where Ready interests come from (the person's own requests from the request authority, list and import wants among
/// them, and explicit follows; never someone else's, never a cancelled or declined request, never a union of JE and
/// Seerr), the Hidden Content rules for the library surface, the caller-only settings routes, and the notification
/// settings write that no longer loses a change made meanwhile.
/// </summary>
[Collection("Plugin singleton")]
public class ReadyInterestsAndRoutesTests
{
    private static PluginConfiguration JeMode() => new() { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrRequestBackend = "je" };

    [Fact]
    public async Task InJellyfinEnhancedModeTheInterestsAreThePersonsOwnLiveWantsAndFollows()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        var notify = new NotifyStore(r.Db);
        var config = JeMode();
        using var seerr = new FakeSeerr();
        var model = new SeerrFacts(seerr.Transport, new ArrChangeFeed(() => r.Now), null, () => config, () => r.Now);
        var source = new ReadyInterestSource(r.Ledger, model, notify, null, () => config);

        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { Can4k = true };
        var standard = await r.Create(r.Member, IntegrationRequestLedgerTests.Movie(603));
        var fourK = await r.Create(r.Member, IntegrationRequestLedgerTests.Movie(604, "4k"));
        var cancelled = await r.Create(r.Member, IntegrationRequestLedgerTests.Movie(605));
        r.Ledger.Close(cancelled.RequestId!, r.Member, null, r.Policy, r.Now);
        Assert.Equal("cancelled", r.Ledger.Find(cancelled.RequestId!)!.Status);
        await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(606));
        // A list want is a want of the person who asked from the list.
        var list = r.Ledger.Create(r.Member, new CreateRequest(Guid.NewGuid().ToString("N"), IntegrationRequestLedgerTests.Movie(607)), r.Policy, r.Now, new RequestOrigin(RequestOrigin.ListKind, "list:" + Guid.NewGuid().ToString("N")));
        notify.SetFollow(r.Member, "movie:tmdb:700", "title", false, false, r.Now);
        notify.SetFollow(r.Member, "tv:tvdb:78874", "episodes", false, false, r.Now);
        // A mute of a title is no follow interest; the person's request for it stays.
        notify.SetFollow(r.Member, "movie:tmdb:701", "title", false, false, r.Now);
        notify.SetFollow(r.Member, "movie:tmdb:701", "title", true, false, r.Now);

        var interests = source.For(r.Member)!;
        Assert.Contains(interests, i => i.Id == "w:" + standard.RequestId && !i.FourK && !i.AnyEdition && i.Title.ToString() == "movie:tmdb:603");
        Assert.Contains(interests, i => i.Id == "w:" + fourK.RequestId && i.FourK);
        Assert.Contains(interests, i => i.Id == "w:" + list.RequestId);
        Assert.DoesNotContain(interests, i => i.Id == "w:" + cancelled.RequestId);
        Assert.DoesNotContain(interests, i => i.Title.ToString() == "movie:tmdb:606");
        Assert.Contains(interests, i => i.Kind == ReadyInterestKind.Follow && i.AnyEdition && i.Title.ToString() == "movie:tmdb:700");
        Assert.Contains(interests, i => i.Kind == ReadyInterestKind.Follow && i.WholeTitle && i.Title.ToString() == "tv:tvdb:78874");
        Assert.DoesNotContain(interests, i => i.Title.ToString() == "movie:tmdb:701");
        Assert.All(interests, i => Assert.Equal(r.Member, i.UserId));
        Assert.Contains(r.Member, source.Interested(new[] { TitleKey.Parse("movie:tmdb:603")! }));
        Assert.DoesNotContain(r.Kid, source.Interested(new[] { TitleKey.Parse("movie:tmdb:603")! }));
    }

    [Fact]
    public async Task InSeerrModeOnlyACompleteReadOfThePersonsLinkedSeerrRequestsCounts()
    {
        using var rig = new IntegrationNotificationsTests.Rig();
        rig.Config.ArrPhase3Enabled = true;
        rig.Config.ArrRequestBackend = "seerr";
        var source = new ReadyInterestSource(new RequestLedger(rig.Db), rig.Requests, rig.NotifyStore, null, () => rig.Config);
        // Not read yet: unreadable, never "no interests" (that would empty the playlist).
        Assert.Null(source.For(rig.Emma.UserId));

        rig.Request(1, 693134, rig.Emma);
        rig.Request(2, 693135, rig.Emma, is4k: true);
        rig.Request(3, 693136, rig.Emma, status: 3);
        rig.Request(4, 693137, rig.Sam);
        await rig.Requests.RefreshAsync(default);
        var interests = source.For(rig.Emma.UserId)!;
        Assert.Equal(new[] { "s:1", "s:2:4k" }, interests.Select(i => i.Id).OrderBy(i => i, StringComparer.Ordinal));
        Assert.True(interests.Single(i => i.Id == "s:2:4k").FourK);
    }

    [Fact]
    public void HiddenContentRulesApplyForTheLibrarySurfaceOnly()
    {
        var movie = Guid.NewGuid();
        var series = Guid.NewGuid();
        var episode = Guid.NewGuid();
        var data = new UserHiddenContent();
        data.Items["a"] = new HiddenContentItem { ItemId = movie.ToString(), Type = "Movie", HideScope = "global" };
        data.Items["b"] = new HiddenContentItem { ItemId = series.ToString("N"), Type = "Series", HideScope = "library" };
        data.Items["c"] = new HiddenContentItem { ItemId = episode.ToString(), Type = "Episode", HideScope = "nextup" };
        data.Items["movie:tmdb:45745"] = new HiddenContentItem { Type = "Movie", TmdbId = "45745", HideScope = "global" };
        var hides = JellyfinReadyPrivacy.From(data);
        Assert.True(hides.Hidden(Array.Empty<TitleKey>(), movie, null));
        Assert.True(hides.Hidden(Array.Empty<TitleKey>(), Guid.NewGuid(), series));
        Assert.False(hides.Hidden(Array.Empty<TitleKey>(), episode, null));     // a Next Up hide isn't a library hide
        Assert.True(hides.Hidden(new[] { TitleKey.Parse("movie:tmdb:45745")! }, Guid.NewGuid(), null));
        Assert.False(hides.Hidden(new[] { TitleKey.Parse("tv:tmdb:45745")! }, Guid.NewGuid(), null));  // typed: never both namespaces

        data.Settings.FilterLibrary = false;
        Assert.False(JellyfinReadyPrivacy.From(data).Hidden(Array.Empty<TitleKey>(), movie, null));
        data.Settings.FilterLibrary = true;
        data.Settings.Enabled = false;
        Assert.False(JellyfinReadyPrivacy.From(data).Hidden(Array.Empty<TitleKey>(), movie, null));
    }

    [Fact]
    public void HiddenContentThatCantBeReadIsUnreadableNeverEmpty()
    {
        using var core = new CoreFixture();
        var user = Guid.NewGuid();
        var config = new PluginConfiguration { HiddenContentEnabled = true };
        var privacy = new JellyfinReadyPrivacy(core.Manager, () => config);
        Assert.Same(ReadyHides.None, privacy.Load(user));
        var dir = Path.Combine(core.ConfigRoot, user.ToString("N"));
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "hidden-content.json"), "{ not json");
        Assert.Null(privacy.Load(user));
        // Not quarantined by a read-only reader.
        Assert.True(File.Exists(Path.Combine(dir, "hidden-content.json")));
        config.HiddenContentEnabled = false;
        Assert.Same(ReadyHides.None, privacy.Load(user));
    }

    private static AcquireReadyController Controller(ReadyWorld w, ClaimsPrincipal principal)
    {
        var controller = new AcquireReadyController(w.Service, w.Store, new NotifyStore(w.Db), w.View)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            Config = () => w.Config,
            Now = () => w.Now,
        };
        controller.HttpContext.User = principal;
        return controller;
    }

    private static (int Status, JsonElement Json) Of(IActionResult result) => result switch
    {
        ObjectResult o => (o.StatusCode ?? 200, JsonDocument.Parse(JsonSerializer.Serialize(o.Value)).RootElement),
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    [Fact]
    public async Task TheSettingsRoutesArePersonalSwitchGatedAndPrivate()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var me = TestCallers.Principal(emma.UserId, false);

        Assert.Equal(403, Of(Controller(w, TestCallers.ApiKey()).Get()).Status);
        Assert.Equal("user_required", Of(Controller(w, TestCallers.Unknown()).Get()).Json.GetProperty("code").GetString());

        var c = Controller(w, me);
        var got = Of(c.Get());
        Assert.Equal(200, got.Status);
        Assert.Equal("private, no-store", c.Response.Headers.CacheControl.ToString());
        Assert.False(got.Json.GetProperty("playlist").GetProperty("optedIn").GetBoolean());
        Assert.False(got.Json.GetProperty("messages").GetProperty("optedIn").GetBoolean());
        Assert.False(got.Json.GetProperty("messages").GetProperty("enabled").GetBoolean());

        // Messages are switched off: refused, nothing stored.
        Assert.Equal(403, Of(await Controller(w, me).Put(new ReadySettingsRequest { NativeReadyMessages = true }, default)).Status);
        Assert.False(new NotifyStore(w.Db).Prefs(emma.UserId).NativeReadyMessages);

        var on = Of(await Controller(w, me).Put(new ReadySettingsRequest { ReadyPlaylist = true }, default));
        Assert.True(on.Json.GetProperty("playlist").GetProperty("optedIn").GetBoolean());
        Assert.Equal(400, Of(await Controller(w, me).Put(new ReadySettingsRequest(), default)).Status);

        w.Config.ArrPhase2Enabled = true;
        w.Config.ArrNotificationsEnabled = true;
        w.Config.ArrPhase4ReadyMessagesEnabled = true;
        var both = Of(await Controller(w, me).Put(new ReadySettingsRequest { NativeReadyMessages = true }, default));
        Assert.True(both.Json.GetProperty("messages").GetProperty("optedIn").GetBoolean());
        Assert.True(both.Json.GetProperty("playlist").GetProperty("optedIn").GetBoolean());

        // Remove: nothing made yet, then a made playlist removed.
        Assert.Equal("nothing", Of(await Controller(w, me).Remove(default)).Json.GetProperty("outcome").GetString());
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.Equal(w.Host.Playlists.Keys.Single().ToString("N"), Of(Controller(w, me).Get()).Json.GetProperty("playlist").GetProperty("playlistId").GetString());
        Assert.Equal("removed", Of(await Controller(w, me).Remove(default)).Json.GetProperty("outcome").GetString());
        Assert.Empty(w.Host.Playlists);

        // Both switches off: the whole route is off.
        w.Config.ArrPhase4ReadyPlaylistEnabled = false;
        w.Config.ArrPhase4ReadyMessagesEnabled = false;
        Assert.Equal("feature_disabled", Of(Controller(w, me).Get()).Json.GetProperty("code").GetString());
    }

    [Fact]
    public void TwoPreferenceWritesAtOnceNeverLoseEachOthersChange()
    {
        using var core = new CoreFixture();
        using var db = new AcquireDatabase(Path.Combine(core.Root, AcquireDatabase.FileName));
        var store = new NotifyStore(db);
        var user = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        Parallel.For(0, 200, i =>
        {
            if (i % 2 == 0) store.UpdatePrefs(user, p => p.HideTitles = !p.HideTitles, now);
            else store.UpdatePrefs(user, p => p.Toasts = !p.Toasts, now);
        });
        // 100 flips of each: both back where they started.
        var prefs = store.Prefs(user);
        Assert.False(prefs.HideTitles);
        Assert.True(prefs.Toasts);
    }
}
