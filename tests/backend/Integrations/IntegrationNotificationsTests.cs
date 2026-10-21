using System.Net.Mail;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// The notification side of "Requests &amp; downloads" (phase 2) against fakes of Radarr/Sonarr,
/// Seerr, Jellyfin, ntfy and SMTP: which transitions tell which users on which channels; first
/// looks that announce nothing; episode batching (window, season packs, single episodes);
/// idempotence across a restart over the same database; declined and approval events from Seerr;
/// quiet hours; privacy (library access and parental limits); retries and give-up of deliveries;
/// admin events (outage, recovery, low disk, stuck digest) and "Remind".
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationNotificationsTests
{
    private static readonly DateTime Asked = new(2026, 10, 12, 9, 0, 0, DateTimeKind.Utc);
    private const string Dune = "movie:tmdb:693134";
    private const string Severance = "tv:tvdb:371980";

    internal sealed class FakeUsers : INotifyUsers
    {
        public List<Guid> AdminIds { get; } = new();
        public Dictionary<Guid, string> Names { get; } = new();
        public HashSet<Guid> Gone { get; } = new();
        public HashSet<Guid> Disabled { get; } = new();

        /// <summary>Makes the item-name lookup throw (a Jellyfin library query failing mid-scan).</summary>
        public bool FailItemName { get; set; }

        public IReadOnlyList<Guid> Admins() => AdminIds;

        public bool Exists(Guid userId) => !Gone.Contains(userId);

        public bool IsActive(Guid userId) => !Gone.Contains(userId) && !Disabled.Contains(userId);

        public string? Name(Guid userId) => Names.TryGetValue(userId, out var n) ? n : null;

        public string? ItemName(Guid itemId) => FailItemName ? throw new InvalidOperationException("library busy") : "Jellyfin Name";
    }

    internal sealed record SentMail(string To, string Subject, string Text, string Html, string HtmlType, string? Unsubscribe, string Password);

    internal sealed class FakeMail : IMailTransport
    {
        public List<SentMail> Sent { get; } = new();
        public bool Fail { get; set; }

        public Task SendAsync(PluginConfiguration config, string password, MailMessage message, CancellationToken cancellationToken)
        {
            if (Fail) throw new SmtpException("mailbox unavailable");
            var view = message.AlternateViews.Count > 0 ? message.AlternateViews[0] : null;
            var html = view != null ? new StreamReader(view.ContentStream).ReadToEnd() : string.Empty;
            lock (Sent) Sent.Add(new SentMail(message.To[0].Address, message.Subject, message.Body, html, view?.ContentType.MediaType ?? string.Empty, message.Headers["List-Unsubscribe"], password));
            return Task.CompletedTask;
        }
    }

    internal sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Sonarr { get; }
        public FakeSeerr Seerr { get; } = new();
        public ArrStateStore Store { get; }
        // Like Jellyfin, any copy, episode or season can be resolved (the dispatcher re-checks them).
        public FakeJellyfinView View { get; } = new() { ResolveAnyItem = true };
        public SeerrRequestReadModel Requests { get; }
        public ArrStatusService Status { get; }
        public ArrChangeFeed Feed { get; } = new();
        public FakeUsers Users { get; } = new();
        public FakeMail Mail { get; } = new();
        public List<(string Url, string? Auth, JsonObject Body)> Pushes { get; } = new();
        public int PushStatus { get; set; } = 200;
        /// <summary>Runs inside every push before it is answered (tests change settings mid-round or hold a send).</summary>
        public Func<Task>? OnPush { get; set; }
        public IntegrationTransport Ntfy { get; }
        public AcquireDatabase Db { get; private set; } = null!;
        public NotifyStore NotifyStore { get; private set; } = null!;
        public NotifyDispatcher Dispatcher { get; private set; } = null!;
        public NotificationService Service { get; private set; } = null!;
        // The admin tools (phase 2): the Jellyfin bridge over an in-memory library and the hub whose
        // Needs attention list the administrators' alerts read.
        public FakeLibraryAccess Library { get; } = new();
        public JellyfinBridge Bridge { get; }
        public ArrAdminHubService Hub { get; }
        public StatusViewer Admin { get; }
        public StatusViewer Emma { get; }
        public StatusViewer Sam { get; }
        public StatusViewer Kid { get; }
        public string DbPath => Path.Combine(Arr.Plugin.Core.Root, "notify", AcquireDatabase.FileName);
        public PluginConfiguration Config => Arr.Plugin.Plugin.Configuration;

        public Rig()
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Arr.Configure(("RadarrZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
            var c = Config;
            c.ArrIntegrationEnabled = true;
            c.ArrPhase1Enabled = true;
            c.ArrPhase2Enabled = true;
            c.ArrHouseholdContactName = "Dad";
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;
            c.ArrNotifyHouseholdUrl = "https://jf.example/";
            c.ArrNtfyEnabled = true;
            c.ArrNtfyServerUrl = "http://ntfy.lan";
            c.ArrNtfyToken = "NTFY-TOKEN-SECRET-123";
            c.ArrEmailEnabled = true;
            c.ArrSmtpHost = "smtp.lan";
            c.ArrSmtpPort = 587;
            c.ArrSmtpFrom = "jellyfin@home.test";
            c.ArrSmtpUsername = "jf";
            c.ArrSmtpPassword = "SMTP-PASS-SECRET-456";

            Radarr.Movies.Add(FakeArr.Movie(2, 693134, "Dune Part Two", hasFile: false));
            Sonarr.Series.Add(FakeArr.SeriesRow(5, 371980, "Severance"));
            Store = Arr.Store();
            Requests = new SeerrRequestReadModel(Seerr.Transport, Feed, null, () => Config, () => Arr.Now);
            Status = new ArrStatusService(Store, View, Requests, () => Config, () => Arr.Now, Feed, new ArrInstanceLibraries(Store, Library, () => Arr.Now));
            Bridge = new JellyfinBridge(Store, Library, null, () => Config, () => Arr.Now, null) { Debounce = TimeSpan.FromMilliseconds(20) };
            Hub = new ArrAdminHubService(Store, Bridge, Requests, null, null, () => Config, () => Arr.Now);
            Admin = View.AddUser(admin: true, policy: "same");
            Emma = View.AddUser(admin: false, policy: "same");
            Sam = View.AddUser(admin: false, policy: "same");
            Kid = View.AddUser(admin: false, policy: "kid", parental: true);
            Users.AdminIds.Add(Admin.UserId);
            Users.Names[Emma.UserId] = "Emma";
            Users.Names[Admin.UserId] = "Jake";
            Ntfy = new IntegrationTransport(async (request, ct) =>
            {
                if (OnPush is { } onPush) await onPush();
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
                lock (Pushes) Pushes.Add((request.RequestUri!.ToString(), request.Headers.Authorization?.ToString(), body));
                return IntegrationTransport.Response("{}", PushStatus);
            });
            Seerr.Movies[693134] = new JsonObject { ["title"] = "Dune: Part Two", ["releaseDate"] = "2024-03-01", ["posterPath"] = "/dune.jpg" };
            Open();
        }

        /// <summary>(Re)opens the database, store, dispatcher and service over the same file: a restart.</summary>
        public void Open()
        {
            Service?.Dispose();
            Dispatcher?.Dispose();
            Db?.Dispose();
            Db = new AcquireDatabase(DbPath);
            NotifyStore = new NotifyStore(Db);
            Dispatcher = new NotifyDispatcher(NotifyStore, new NtfySender(Ntfy), new EmailSender(Mail), null, () => Config, () => Arr.Now, Users, View, Status.Aliases);
            Service = new NotificationService(NotifyStore, Status, Requests, View, Feed, Store, Users, Dispatcher, null, null, () => Config, () => Arr.Now, Hub, Bridge);
        }

        public void Prefs(StatusViewer user, Action<NotifyPrefs> change)
        {
            var p = NotifyStore.Prefs(user.UserId);
            change(p);
            NotifyStore.SavePrefs(user.UserId, p, Arr.Now);
        }

        public void Phones(params StatusViewer[] users)
        {
            foreach (var u in users)
            {
                Prefs(u, p =>
                {
                    p.Ntfy = true;
                    p.NtfyTopic = "je-topic-" + u.UserId.ToString("N")[..12];
                    p.Email = true;
                    p.EmailAddress = u.UserId.ToString("N")[..8] + "@home.test";
                });
            }
        }

        public void Request(int id, int tmdb, StatusViewer who, int status = 2, string type = "movie", int? tvdb = null, int[]? seasons = null, bool is4k = false, DateTime? created = null)
            => Seerr.Requests.Add(FakeSeerr.Request(id, type, tmdb, status, who.UserId, created ?? Asked, tvdb: tvdb, seasons: seasons, is4k: is4k, userName: Users.Name(who.UserId) ?? "x"));

        public Guid Arrive(string key, params Guid[] visibleTo)
        {
            var id = Guid.NewGuid();
            View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = id, Path = "/media/" + key, LibraryName = "Movies", DateCreated = Arr.Now.UtcDateTime }, visibleTo);
            View.Rev++;
            return id;
        }

        public IReadOnlyList<(long Id, string Kind, string? Key, string? ItemId, string Payload, DateTimeOffset At, bool Read)> Inbox(StatusViewer user) => NotifyStore.Inbox(user.UserId, null, 50);

        public async Task Step(params string[] keys)
        {
            await Requests.RefreshAsync(default);
            await Service.TickAsync(default);
            if (keys.Length > 0) await Service.EvaluateAsync(keys, null, default);
            Service.FlushBatches(Arr.Now);
            await Dispatcher.RunOnceAsync(default);
        }

        public void Dispose()
        {
            Service.Dispose();
            Bridge.Dispose();
            Dispatcher.Dispose();
            Db.Dispose();
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Requests.Dispose();
            Seerr.Dispose();
            Ntfy.Dispose();
            Arr.Dispose();
        }
    }

    internal static async Task<Rig> Started(Action<Rig>? setup = null)
    {
        var rig = new Rig();
        setup?.Invoke(rig);
        await rig.Requests.RefreshAsync(default);
        // Warm the snapshots once (they load in the background on first use).
        await rig.Status.ComposeForAsync(rig.Admin, new[] { TitleKey.Parse(Dune)!, TitleKey.Parse(Severance)! }, null, default);
        await Task.Delay(50);
        await rig.Status.ComposeForAsync(rig.Admin, new[] { TitleKey.Parse(Dune)!, TitleKey.Parse(Severance)! }, null, default);
        await rig.Step();
        return rig;
    }

    private static Dictionary<string, string> Params(string payload) => JsonSerializer.Deserialize<Dictionary<string, string>>(payload)!;

    [Fact]
    public async Task ARequestedMovieThatBecomesReadyTellsTheRequesterAndFollowersOnEveryChannelTheyHaveOn()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma, rig.Sam);
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(Dune)!, true, default));
        await rig.Step(Dune);
        Assert.Empty(rig.Inbox(rig.Emma));

        var item = rig.Arrive(Dune);
        await rig.Step(Dune);

        var emma = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("ready", Dune, item.ToString("N")), (emma.Kind, emma.Key, emma.ItemId));
        var p = Params(emma.Payload);
        Assert.Equal(("Dune Part Two", "1", "/dune.jpg"), (p["title"], p["requested"], p["poster"]));
        Assert.Equal("ready", Assert.Single(rig.Inbox(rig.Sam)).Kind);
        // Nobody else hears about it; the admin who approved has no interest in it.
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == "ready");
        Assert.Empty(rig.Inbox(rig.Kid));
        // Phones: two pushes to the configured server only, the token as a bearer header, a deep link.
        Assert.Equal(2, rig.Pushes.Count);
        Assert.All(rig.Pushes, x => Assert.Equal("http://ntfy.lan/", x.Url));
        Assert.All(rig.Pushes, x => Assert.Equal("Bearer NTFY-TOKEN-SECRET-123", x.Auth));
        var push = rig.Pushes.Single(x => (string)x.Body["topic"]! == "je-topic-" + rig.Emma.UserId.ToString("N")[..12]);
        Assert.Equal("Dune Part Two is ready to watch", (string)push.Body["title"]!);
        Assert.Equal("https://jf.example/web/#/details?id=" + item.ToString("N"), (string)push.Body["click"]!);
        // E-mail: both, plain + HTML, unsubscribe link and header to the settings.
        Assert.Equal(2, rig.Mail.Sent.Count);
        var mail = rig.Mail.Sent.Single(m => m.To.StartsWith(rig.Emma.UserId.ToString("N")[..8], StringComparison.Ordinal));
        Assert.Equal("Dune Part Two is ready to watch", mail.Subject);
        Assert.Equal("<https://jf.example/web/#/home?je=alerts>", mail.Unsubscribe);
        Assert.Equal("text/html", mail.HtmlType);
        Assert.Contains("https://jf.example/web/#/home?je=alerts", mail.Text, StringComparison.Ordinal);
        Assert.Contains("href=\"https://jf.example/web/#/details?id=" + item.ToString("N") + "\"", mail.Html, StringComparison.Ordinal);
        Assert.Equal("SMTP-PASS-SECRET-456", mail.Password);
        // The inbox key of each recipient moved on the feed (their bell updates).
        Assert.True(rig.Feed.Revision(ArrTitleKey.UserInbox(rig.Emma.UserId)) > 0);
        Assert.Equal(0, rig.Feed.Revision(ArrTitleKey.UserInbox(rig.Kid.UserId)));

        // Looking again tells nobody twice.
        await rig.Step(Dune);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(2, rig.Pushes.Count);
    }

    [Fact]
    public async Task ConfirmedQueueDepartureDoesNotAnnounceReadyBeforeJellyfinHasTheCopy()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(Dune)!, true, default));
        var instance = rig.Store.Instances(ArrKind.Radarr).Single();
        var library = rig.Store.PeekLibrary(instance.Id)!;
        var keys = ArrChangeDetector.Queue(ArrKind.Radarr, new ArrQueueSnapshot(), new ArrQueueSnapshot(), library,
            new[] { new ArrQueueEntry { MovieId = 2, TmdbId = 693134 } });
        Assert.Equal(new[] { Dune }, keys);
        rig.Feed.Bump(keys, instance.Id);
        await rig.Step(keys.ToArray());
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Inbox(rig.Sam));
        var item = rig.Arrive(Dune, rig.Emma.UserId, rig.Sam.UserId);
        await rig.Step(keys.ToArray());
        await rig.Step(keys.ToArray());
        Assert.Equal(("ready", item.ToString("N")), (Assert.Single(rig.Inbox(rig.Emma)).Kind, Assert.Single(rig.Inbox(rig.Emma)).ItemId));
        Assert.Single(rig.Inbox(rig.Sam));
    }

    [Fact]
    public async Task UsersWhoCannotOpenTheCopyAreNeverTold()
    {
        // Sam follows Dune but can't open the library it lands in; the kid (parental limits) asked
        // for it himself (so he may follow it) but Jellyfin hides the copy from him.
        using var rig = await Started(r => r.Request(1, 693134, r.Kid));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(Dune)!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Dune)!, true, default));
        rig.Arrive(Dune, rig.Emma.UserId, rig.Admin.UserId);
        await rig.Step(Dune);
        Assert.Equal("ready", Assert.Single(rig.Inbox(rig.Emma)).Kind);
        Assert.Empty(rig.Inbox(rig.Sam));
        Assert.Empty(rig.Inbox(rig.Kid));
        // A kid with content limits may not follow a title that isn't in Jellyfin and that he didn't ask for.
        Assert.Equal("not_allowed", await rig.Service.SetFollowAsync(rig.Kid, TitleKey.Parse("movie:tmdb:4242")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse("movie:tmdb:4242")!, true, default));
    }

    [Fact]
    public async Task FollowingSomethingAlreadyReadyAnnouncesNothingEvenAfterItFlaps()
    {
        using var rig = await Started();
        var copy = rig.Arrive(Dune);
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Dune)!, true, default));
        await rig.Step(Dune);
        Assert.Empty(rig.Inbox(rig.Emma));
        // The copy goes away (an upgrade being swapped in) and comes back: still nothing.
        rig.View.CopiesByKey.Clear();
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Empty(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task ATitleAnnouncedUnderAnotherIdIsTheSameInterestAndToldOnce()
    {
        // Radarr knows Dune by TMDB and IMDb; Jellyfin's library events carry both. Looks under the
        // IMDb key are looks at the same title (one watch state, one notification).
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Service.RebuildInterest();
        await rig.Service.EvaluateAsync(new[] { "movie:imdb:tt693134" }, null, default);
        rig.Arrive(Dune);
        await rig.Service.EvaluateAsync(new[] { "movie:imdb:tt693134" }, null, default);
        await rig.Service.EvaluateAsync(new[] { Dune, "movie:imdb:tt693134" }, null, default);
        var only = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(Dune, only.Key);
        Assert.Null(rig.NotifyStore.Watch(rig.Emma.UserId, "movie:imdb:tt693134", "m"));
    }

    [Fact]
    public async Task NotificationsAreIdempotentAcrossARestartAndCatchUpWhatHappenedWhileDown()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        await rig.Step(Dune);
        // "Restart": everything reopened over the same database while the title arrives.
        rig.Open();
        rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Single(rig.Pushes);
        rig.Open();
        await rig.Step(Dune);
        await rig.Step(Dune);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
    }

    [Fact]
    public async Task NewEpisodesAreBatchedPerSeriesWithSeasonPacksCollapsed()
    {
        // Sonarr knows Season 2 has nine episodes.
        using var rig = await Started(r => r.Sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 2, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 9, ["episodeFileCount"] = 9, ["totalEpisodeCount"] = 9 } }));
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        var season1 = Guid.NewGuid();
        rig.View.AddSeason(series, new JfSeason { ItemId = season1, Season = 1 });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Severance)!, true, default));
        Assert.Equal(("episodes", "1:1"), (rig.NotifyStore.Follows(rig.Emma.UserId).Single().Kind, rig.NotifyStore.Watch(rig.Emma.UserId, Severance, "eps")!.Value.Known));

        // Two episodes arrive within the window: nothing until it closes, then one message.
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(4);
        var e3 = Guid.NewGuid();
        rig.View.AddEpisode(series, new JfEpisode { ItemId = e3, Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        Assert.Empty(rig.Inbox(rig.Emma));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(6);
        await rig.Step();
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        var p = Params(batch.Payload);
        Assert.Equal(("episodes", "many", "2", "Severance"), (batch.Kind, p["mode"], p["count"], p["title"]));
        Assert.Equal(series.ToString("N"), batch.ItemId);

        // One more episode alone: "episode 4 is ready", linked to the episode.
        var e4 = Guid.NewGuid();
        rig.View.AddEpisode(series, new JfEpisode { ItemId = e4, Season = 1, Episode = 4, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        var single = rig.Inbox(rig.Emma)[0];
        Assert.Equal(("single", "1", "4", e4.ToString("N")), (Params(single.Payload)["mode"], Params(single.Payload)["season"], Params(single.Payload)["episode"], single.ItemId));

        // A whole season at once (a season pack) collapses to "Season 2 is ready", linked to the season.
        var season2 = Guid.NewGuid();
        rig.View.AddSeason(series, new JfSeason { ItemId = season2, Season = 2 });
        for (var n = 1; n <= 9; n++) rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = n, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        var pack = rig.Inbox(rig.Emma)[0];
        Assert.Equal(("season", "2", "9", season2.ToString("N")), (Params(pack.Payload)["mode"], Params(pack.Payload)["season"], Params(pack.Payload)["count"], pack.ItemId));
        Assert.Equal(3, rig.Inbox(rig.Emma).Count);
        // Episode texts carry numbers only (never an episode's name).
        Assert.DoesNotContain("Jellyfin Name", string.Join("|", rig.Inbox(rig.Emma).Select(n => n.Payload)), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ASeriesJellyfinKnowsOnlyByItsTmdbIdStillGetsItsEpisodeBatchOnce()
    {
        // Sonarr has Severance (TVDB 371980, TMDB 95396); Jellyfin's copy carries only the TMDB id.
        // Emma follows it by its TMDB key: the canonical key is the TVDB one, and the copy is still
        // found by the alias.
        using var rig = await Started(r => r.Sonarr.Series[0]["tmdbId"] = 95396);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("SonarrZ").Id, ArrSnapshotKind.Library, force: true);
        var series = Guid.NewGuid();
        var tmdbKey = TitleKey.Parse("tv:tmdb:95396")!;
        rig.View.AddCopy(tmdbKey, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, tmdbKey, true, default));
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "single", "2"), (batch.Kind, Params(batch.Payload)["mode"], Params(batch.Payload)["episode"]));
        // The Jellyfin lookup asked for the key and every alias of its kind (never a movie key).
        Assert.Contains(rig.View.CopyQueries, q => q.Contains("tv:tvdb:371980") && q.Contains("tv:tmdb:95396") && q.All(k => k.StartsWith("tv:", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task ASeasonRequestTellsAboutThatSeasonOnlyAndAnUpgradedEpisodeIsNotNewAgain()
    {
        using var rig = await Started(r => r.Request(3, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }));
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        var old = Guid.NewGuid();
        rig.View.AddEpisode(series, new JfEpisode { ItemId = old, Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        await rig.Step(Severance);
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        var only = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("2", "1"), (Params(only.Payload)["season"], Params(only.Payload)["episode"]));
        // S1E1 replaced by a new item (an upgrade with a new file name): known, not announced.
        rig.View.EpisodesBySeries[series].RemoveAll(e => e.Episode.ItemId == old);
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task SeerrDeclinesTellTheRequesterAndNewRequestsTellAdminsOnlyAfterTheFirstScan()
    {
        // Before notifications were first switched on: an old declined and an old pending request.
        using var rig = await Started(r =>
        {
            r.Request(5, 888, r.Emma, status: 3);
            r.Request(6, 999, r.Sam, status: 1);
        });
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Inbox(rig.Admin));

        // A new request waits for an OK: administrators hear about it (once), the requester doesn't.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 1, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        var approval = Assert.Single(rig.Inbox(rig.Admin));
        Assert.Equal(("approval", "Emma", "Dune Part Two"), (approval.Kind, Params(approval.Payload)["user"], Params(approval.Payload)["title"]));
        Assert.Empty(rig.Inbox(rig.Emma));

        // It is declined: Emma hears it with the household's name for the owner; again: nothing new.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 7);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 3, rig.Emma.UserId, rig.Arr.Now.UtcDateTime.AddMinutes(-1), rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        await rig.Step();
        var declined = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("declined", "Dad"), (declined.Kind, Params(declined.Payload)["contact"]));
        Assert.Single(rig.Inbox(rig.Admin));
        // An administrator's own request needs no OK message to themselves.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(8, "movie", 4242, 1, rig.Admin.UserId, rig.Arr.Now.UtcDateTime));
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Admin));
        // A request first seen now but made before notifications started (an old one the list only now
        // shows) is not news.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(9, "movie", 4343, 1, rig.Sam.UserId, Asked.AddDays(-30), rig.Arr.Now.UtcDateTime));
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Admin));
    }

    [Fact]
    public async Task AdminAlertsReachAdministratorsPhonesOnlyWhenTheyWantThem()
    {
        using var rig = await Started();
        rig.Phones(rig.Admin);
        rig.Prefs(rig.Admin, p => p.AdminAlerts = false);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 1, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Equal("approval", Assert.Single(rig.Inbox(rig.Admin)).Kind);
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        // A family event still goes to the administrator's phone (only admin alerts are switched off).
        Assert.True(rig.Service.SendTest(rig.Admin.UserId));
        await rig.Step();
        Assert.Single(rig.Pushes);
        rig.Prefs(rig.Admin, p => p.AdminAlerts = true);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(8, "movie", 4242, 1, rig.Sam.UserId, rig.Arr.Now.UtcDateTime));
        await rig.Step();
        Assert.Equal(2, rig.Pushes.Count);
    }

    [Fact]
    public async Task QuietHoursHoldPhoneAndEmailUntilTheyEndButNotTheInbox()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        // 12:00 UTC is 23:00 in a +11 zone: inside 22:00-07:00.
        rig.Prefs(rig.Emma, p => { p.QuietHours = true; p.QuietFrom = "22:00"; p.QuietTo = "07:00"; p.TimeZone = "Not/AZone"; p.UtcOffsetMinutes = 11 * 60; });
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        rig.Arr.Now = rig.Arr.Now.AddHours(7).AddMinutes(59);
        await rig.Step();
        Assert.Empty(rig.Pushes);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.Step();
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
    }

    [Theory]
    [InlineData("22:00", "07:00", 23, 30, "07:00")]
    [InlineData("22:00", "07:00", 6, 59, "07:00")]
    [InlineData("22:00", "07:00", 7, 0, null)]
    [InlineData("13:00", "15:00", 14, 0, "15:00")]
    [InlineData("13:00", "15:00", 15, 30, null)]
    public void QuietHoursSpanMidnightAndUseTheUsersClock(string from, string to, int hour, int minute, string? endsAt)
    {
        var prefs = new NotifyPrefs { QuietHours = true, QuietFrom = from, QuietTo = to, UtcOffsetMinutes = 120 };
        var now = new DateTimeOffset(2026, 10, 12, hour, minute, 0, TimeSpan.FromHours(2));
        var end = QuietHours.EndsAt(prefs, now);
        Assert.Equal(endsAt, end?.ToOffset(TimeSpan.FromHours(2)).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture));
        if (end != null) Assert.True(end > now && end - now <= TimeSpan.FromHours(24));
        Assert.Null(QuietHours.EndsAt(new NotifyPrefs { QuietHours = false }, now));
    }

    [Fact]
    public async Task FailedDeliveriesRetryWithBackoffThenGiveUpVisiblyAndNeverLogASecret()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        rig.PushStatus = 403;
        rig.Mail.Fail = true;
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Single(rig.Pushes);
        var stats = rig.NotifyStore.DeliveryStats(rig.Arr.Now);
        Assert.Equal(2, stats.Pending);
        Assert.Contains(stats.Problems, x => x.Channel == "ntfy" && x.Error!.Contains("403", StringComparison.Ordinal) && !x.Final);
        // Not again before the backoff; then every step up to six retries; then given up.
        await rig.Step();
        Assert.Single(rig.Pushes);
        foreach (var wait in NotifyDispatcher.Backoff)
        {
            rig.Arr.Now += wait;
            await rig.Step();
        }
        Assert.Equal(1 + NotifyDispatcher.Backoff.Length, rig.Pushes.Count);
        rig.Arr.Now += TimeSpan.FromDays(1);
        await rig.Step();
        Assert.Equal(1 + NotifyDispatcher.Backoff.Length, rig.Pushes.Count);
        stats = rig.NotifyStore.DeliveryStats(rig.Arr.Now.AddDays(-1));
        Assert.Equal(0, stats.Pending);
        Assert.Equal(2, stats.Failed24h);
        Assert.All(stats.Problems.Where(x => x.Final), x => Assert.Equal(7, x.Attempts));
        // The failure texts and the log never carry the token or the password.
        var everything = string.Join("|", stats.Problems.Select(x => x.Error)) + File.ReadAllText(Directory.GetFiles(rig.Arr.Plugin.Core.Root, "*.log", SearchOption.AllDirectories).DefaultIfEmpty(rig.DbPath).First());
        Assert.DoesNotContain("NTFY-TOKEN-SECRET", everything, StringComparison.Ordinal);
        Assert.DoesNotContain("SMTP-PASS-SECRET", everything, StringComparison.Ordinal);

        // A recovered channel delivers the next one at once.
        rig.PushStatus = 200;
        rig.Mail.Fail = false;
        Assert.True(rig.Service.SendTest(rig.Emma.UserId));
        await rig.Step();
        Assert.Equal("Test from Jellyfin Enhanced", (string)rig.Pushes[^1].Body["title"]!);
        Assert.Single(rig.Mail.Sent);
    }

    [Fact]
    public async Task HiddenTitlesAndSwitchedOffEventsAreRespected()
    {
        using var rig = await Started(r =>
        {
            r.Request(1, 693134, r.Emma);
            r.Request(2, 693134, r.Sam);
        });
        rig.Phones(rig.Emma, rig.Sam);
        rig.Prefs(rig.Emma, p => p.HideTitles = true);
        rig.Prefs(rig.Sam, p => p.Ready = false);
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        var push = Assert.Single(rig.Pushes);
        Assert.Equal("Something you're waiting for is ready", (string)push.Body["title"]!);
        Assert.DoesNotContain("Dune", push.Body.ToJsonString(), StringComparison.Ordinal);
        var hidden = Assert.Single(rig.Mail.Sent);
        Assert.DoesNotContain("Dune", hidden.Subject + hidden.Text + hidden.Html, StringComparison.Ordinal);
        Assert.Empty(rig.Inbox(rig.Sam));
        // Turning "follow what I request" off ends the automatic follow; a mute does too.
        rig.Prefs(rig.Emma, p => p.AutoFollowRequests = false);
        Assert.Empty(rig.Service.FollowsOf(rig.Emma.UserId).Requested);
    }

    [Fact]
    public async Task RemindTellsAdminsOnceADayAndOnlyAboutTitlesThatNeedAttention()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning"));
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        var key = TitleKey.Parse(Dune)!;
        var first = await rig.Service.RemindAsync(rig.Emma, key, null, default);
        Assert.Equal("ok", first.Code);
        var remind = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "remind");
        Assert.Equal(("Emma", "Dune Part Two"), (Params(remind.Payload)["user"], Params(remind.Payload)["title"]));
        var again = await rig.Service.RemindAsync(rig.Emma, key, null, default);
        Assert.Equal(("too_soon", first.NextAt), (again.Code, again.NextAt));
        rig.Arr.Now = rig.Arr.Now.AddHours(24).AddMinutes(1);
        Assert.Equal("ok", (await rig.Service.RemindAsync(rig.Emma, key, null, default)).Code);
        Assert.Equal(2, rig.Inbox(rig.Admin).Count(n => n.Kind == "remind"));
        Assert.Equal("admin", (await rig.Service.RemindAsync(rig.Admin, key, null, default)).Code);
        Assert.Equal("not_stuck", (await rig.Service.RemindAsync(rig.Emma, TitleKey.Parse("movie:tmdb:4242")!, null, default)).Code);
    }

    [Fact]
    public async Task ARemindNamesItsTitleOnlyToAdministratorsWhoCanSeeIt()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning"));
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        // Pat is an administrator too, with a parental limit Dune is over (or without the library it is in).
        var policy = new IntegrationRequestLedgerTests.Policy();
        var pat = rig.View.AddUser(admin: true, policy: "pat", parental: true);
        rig.Users.AdminIds.Add(pat.UserId);
        rig.Users.Names[pat.UserId] = "Pat";
        var cannotSee = new HashSet<Guid> { pat.UserId };
        policy.Adjust = (user, input, facts) => facts with { Visible = !cannotSee.Contains(user) };
        rig.Phones(rig.Admin, pat);
        rig.Prefs(rig.Admin, p => { p.AdminAlerts = true; p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        rig.Prefs(pat, p => p.AdminAlerts = true);
        using var dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, null, policy);
        using var service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, null, null, policy);

        // Emma reminds about Dune: the administrator who can see it is told; Pat is told nothing, on no channel.
        Assert.Equal("ok", (await service.RemindAsync(rig.Emma, TitleKey.Parse(Dune)!, null, default)).Code);
        Assert.Contains("Dune Part Two", Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "remind").Payload, StringComparison.Ordinal);
        Assert.Empty(rig.Inbox(pat));
        await dispatcher.RunOnceAsync(default);
        Assert.Empty(rig.Pushes);

        // The administrator loses sight of Dune: the inbox keeps the reminder without its title, and the phone and
        // e-mail held for quiet hours don't go out.
        cannotSee.Add(rig.Admin.UserId);
        var controller = new Jellyfin.Plugin.JellyfinEnhanced.Controllers.NotifyController(service, dispatcher, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), rig.Users)
        {
            ControllerContext = new Microsoft.AspNetCore.Mvc.ControllerContext { HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext() },
            Config = () => rig.Config,
            Now = () => rig.Arr.Now,
        };
        controller.HttpContext.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim("Jellyfin-UserId", rig.Admin.UserId.ToString())], "test"));
        var inbox = JsonSerializer.Serialize(((Microsoft.AspNetCore.Mvc.ObjectResult)controller.GetInbox(null, null)).Value);
        Assert.Contains("\"remind\"", inbox, StringComparison.Ordinal);
        Assert.DoesNotContain("Dune", inbox, StringComparison.Ordinal);
        Assert.DoesNotContain(Dune, inbox, StringComparison.Ordinal);
        rig.Prefs(rig.Admin, p => p.QuietHours = false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await dispatcher.RunOnceAsync(default);
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        Assert.Equal(0, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
    }

    [Fact]
    public async Task AdminsHearAboutAnOutageOnceItLastsAndWhenItEnds()
    {
        using var rig = await Started();
        var radarr = rig.Arr.Hosts["radarr.lan"];
        // The system facts were read a moment ago (healthy); Radarr stops answering. The store
        // reads it again once its facts are 5 minutes old: that failure starts the outage clock.
        radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(6);
        await Checks(rig);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(9);
        await Checks(rig);
        Assert.Empty(rig.Inbox(rig.Admin));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await Checks(rig);
        await Checks(rig);
        var down = Assert.Single(rig.Inbox(rig.Admin));
        Assert.Equal(("instance_down", "RadarrZ"), (down.Kind, Params(down.Payload)["instance"]));
        Assert.Empty(rig.Inbox(rig.Emma));
        radarr.FailWith = 0;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(30);
        await Checks(rig, healthy: true);
        Assert.Equal("instance_up", rig.Inbox(rig.Admin)[0].Kind);
        Assert.Equal(2, rig.Inbox(rig.Admin).Count);
    }

    // Two rounds of admin checks (the first starts the store's background read, the second sees it).
    private static async Task Checks(Rig rig, bool healthy = false)
    {
        await rig.Service.AdminChecksAsync(default);
        // Wait for the background read the first round started (the client retries a 503 once).
        var radarr = rig.Arr.Instance("RadarrZ");
        for (var i = 0; i < 100; i++)
        {
            var read = await rig.Store.GetSystemAsync(radarr, default);
            if (healthy ? read.Error == null && read.LoadedAt == rig.Arr.Now : read.Error != null) break;
            await Task.Delay(50);
        }
        await rig.Service.AdminChecksAsync(default);
    }

    [Fact]
    public async Task TheStuckDigestListsDownloadsNeedingAttentionForHoursOnceADayAtItsHour()
    {
        using var rig = await Started();
        // Added 7 hours ago, but first seen blocked now: "stuck for hours" is counted from when JE
        // first saw the problem (never from the grab), so it is not in today's digest.
        var old = FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning");
        old["added"] = rig.Arr.Now.UtcDateTime.AddHours(-7).ToString("o");
        var fine = FakeArr.RadarrQueueRow(4, 2, "Fine Film");
        fine["added"] = rig.Arr.Now.UtcDateTime.AddHours(-9).ToString("o");
        rig.Radarr.Queue.AddRange(new[] { old, fine });
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        var hour = TimeZoneInfo.ConvertTime(rig.Arr.Now, TimeZoneInfo.Local).Hour;
        // Not its hour: nothing.
        rig.Config.ArrNotifyDigestHour = (hour + 1) % 24;
        await rig.Service.AdminChecksAsync(default);
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");
        // Its hour, first sight: nothing stuck yet (the day is done).
        rig.Config.ArrNotifyDigestHour = hour;
        await rig.Service.AdminChecksAsync(default);
        await rig.Service.AdminChecksAsync(default);
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");

        // A day later the same download is still blocked (every re-read keeps its clock), and a new
        // one has just been seen blocked: only the first is stuck.
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        var fresh = FakeArr.RadarrQueueRow(3, 1, "Fresh Film", state: "importBlocked", status: "warning");
        fresh["added"] = rig.Arr.Now.UtcDateTime.AddHours(-30).ToString("o");
        rig.Radarr.Queue.Add(fresh);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        rig.Config.ArrNotifyDigestHour = TimeZoneInfo.ConvertTime(rig.Arr.Now, TimeZoneInfo.Local).Hour;
        await ChecksSurvivingErrors(rig);
        await rig.Service.AdminChecksAsync(default);
        var digest = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");
        var p = Params(digest.Payload);
        Assert.Equal(("1", "6"), (p["count"], p["hours"]));
        Assert.Equal("Dune Part Two (RadarrZ, import_blocked)", p["items"]);
        Assert.Empty(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task AStalledDownloadIsStuckFromWhenJeFirstSawItStallNotFromItsGrab()
    {
        using var rig = await Started();
        // Grabbed 7 hours ago and downloading normally; now the client says no time is left while
        // data is still missing (download_stalled). First sight: not stuck yet.
        var row = FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two");
        row["added"] = rig.Arr.Now.UtcDateTime.AddHours(-7).ToString("o");
        row["timeleft"] = "00:00:00";
        rig.Radarr.Queue.Add(row);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        rig.Config.ArrNotifyDigestHour = TimeZoneInfo.ConvertTime(rig.Arr.Now, TimeZoneInfo.Local).Hour;
        await ChecksSurvivingErrors(rig);
        await rig.Service.AdminChecksAsync(default);
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");
        // A day later it is still stalled (every re-read keeps its clock): stuck.
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        rig.Config.ArrNotifyDigestHour = TimeZoneInfo.ConvertTime(rig.Arr.Now, TimeZoneInfo.Local).Hour;
        await ChecksSurvivingErrors(rig);
        await rig.Service.AdminChecksAsync(default);
        var digest = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");
        Assert.Equal("Dune Part Two (RadarrZ, download_stalled)", Params(digest.Payload)["items"]);
    }

    [Fact]
    public async Task AFinishedDownloadTheArrCannotImportIsReportedInTheStuckDigest()
    {
        using var rig = await Started();
        // Sonarr/Radarr leave a finished download it can't import at state "downloading" with a
        // warning: it is waiting to import (not downloading), and it is listed once it lasts.
        var row = FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "downloading", status: "warning");
        row["status"] = "completed";
        row["sizeleft"] = 0;
        rig.Radarr.Queue.Add(row);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        rig.Arr.Now = rig.Arr.Now.AddHours(7);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        rig.Config.ArrNotifyDigestHour = TimeZoneInfo.ConvertTime(rig.Arr.Now, TimeZoneInfo.Local).Hour;
        await ChecksSurvivingErrors(rig);
        await rig.Service.AdminChecksAsync(default);
        var digest = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");
        Assert.Equal("Dune Part Two (RadarrZ, import_waiting)", Params(digest.Payload)["items"]);
    }

    [Fact]
    public async Task LowDiskIsToldOncePerFolderAndDay()
    {
        using var rig = await Started(r =>
        {
            const long Gb = 1024L * 1024 * 1024;
            r.Radarr.DiskSpace.Add(new JsonObject { ["path"] = "/data", ["freeSpace"] = 5 * Gb, ["totalSpace"] = 100 * Gb });
            r.Radarr.DiskSpace.Add(new JsonObject { ["path"] = "/", ["freeSpace"] = 50 * Gb, ["totalSpace"] = 100 * Gb });
            r.Radarr.RootFolders.Add(new JsonObject { ["path"] = "/data/movies", ["freeSpace"] = 5 * Gb, ["accessible"] = true });
            r.Radarr.RootFolders.Add(new JsonObject { ["path"] = "/other", ["freeSpace"] = 50 * Gb, ["accessible"] = true });
        });
        await rig.Service.AdminChecksAsync(default);
        await rig.Service.AdminChecksAsync(default);
        var disk = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "low_disk");
        var p = Params(disk.Payload);
        Assert.Equal(("RadarrZ", "/data/movies", "5", "5.0 GB"), (p["instance"], p["path"], p["percent"], p["free"]));
        Assert.Empty(rig.Inbox(rig.Emma));
        // Next day, still low: told again; under the admin tools' lowest threshold (1 %): never.
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await Checks(rig, healthy: true);
        Assert.Equal(2, rig.Inbox(rig.Admin).Count(n => n.Kind == "low_disk"));
        rig.Config.ArrLowDiskPercent = 1;
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await Checks(rig, healthy: true);
        Assert.Equal(2, rig.Inbox(rig.Admin).Count(n => n.Kind == "low_disk"));
    }

    [Fact]
    public void EndpointsAreAdminConfiguredOnlyAndUserInputCannotPointAnywhere()
    {
        Assert.Equal("https://ntfy.sh", NotifyEndpoints.NtfyServer(" https://ntfy.sh/ "));
        Assert.Equal("http://ntfy.lan:8080/base", NotifyEndpoints.NtfyServer("http://ntfy.lan:8080/base"));
        foreach (var bad in new[] { "ftp://ntfy.sh", "https://user:pw@ntfy.sh", "https://ntfy.sh/?x=1", "https://ntfy.sh/#a", "http://169.254.169.254", "http://[::ffff:169.254.169.254]", "http://metadata.google.internal", "ntfy.sh", "" })
            Assert.Null(NotifyEndpoints.NtfyServer(bad));
        Assert.True(NotifyEndpoints.IsTopic("je-abcdefgh"));
        foreach (var bad in new[] { "short", "../../etc", "a/b/cdefghij", "topic with space", "x".PadRight(65, 'x'), "abcdefgh?x=1", "%2e%2e%2fabcd" })
            Assert.False(NotifyEndpoints.IsTopic(bad));
        var generated = NotifyEndpoints.NewTopic();
        Assert.True(NotifyEndpoints.IsTopic(generated));
        Assert.Equal(29, generated.Length);
        Assert.NotEqual(generated, NotifyEndpoints.NewTopic());
        Assert.Equal("me@home.test", NotifyEndpoints.EmailAddress(" me@home.test "));
        foreach (var bad in new[] { "me@home.test\r\nBcc: x@y.z", "a@b.c, d@e.f", "Name <a@b.c>", "nobody", "a@localhost" })
            Assert.Null(NotifyEndpoints.EmailAddress(bad));
        Assert.Null(NotifyEndpoints.SmtpHost("smtp.lan:25/x"));
        Assert.Equal("https://jf.example", NotifyEndpoints.HouseholdUrl(new PluginConfiguration { ArrNotifyHouseholdUrl = "https://jf.example/web/" }));
        Assert.Null(NotifyEndpoints.HouseholdUrl(new PluginConfiguration { ArrNotifyHouseholdUrl = "javascript:alert(1)" }));
    }

    [Fact]
    public async Task NtfyRedirectsAreNotFollowedAndOnlyTheTopicLeavesTheUser()
    {
        var calls = new List<HttpRequestMessage>();
        using var transport = new IntegrationTransport((r, _) =>
        {
            calls.Add(r);
            var res = IntegrationTransport.Response("", 302);
            res.Headers.Location = new Uri("http://169.254.169.254/latest");
            return Task.FromResult(res);
        });
        var sender = new NtfySender(transport);
        var result = await sender.SendAsync("http://ntfy.lan", null, "je-abcdefgh", new NotifyMessage("t", "b"), null, null, 3, default);
        Assert.False(result.Ok);
        Assert.Contains("redirect", result.Error, StringComparison.OrdinalIgnoreCase);
        Assert.Single(calls);
        Assert.Equal("http://ntfy.lan/", calls[0].RequestUri!.ToString());
        Assert.False((await sender.SendAsync("http://ntfy.lan", null, "../admin", new NotifyMessage("t", "b"), null, null, 3, default)).Ok);
        Assert.Single(calls);
        // The production handler never follows redirects and checks the address it connects to.
        Assert.False(ArrHttp.CreateHandler().AllowAutoRedirect);
    }

    [Fact]
    public async Task TheDatabaseMigratesOnceRefusesANewerSchemaAndBacksUpThroughSqlite()
    {
        var dir = Path.Combine(Path.GetTempPath(), "je-notify-db-" + Guid.NewGuid().ToString("N"));
        try
        {
            var path = Path.Combine(dir, AcquireDatabase.FileName);
            using (var db = new AcquireDatabase(path))
            {
                Assert.True(db.Available);
                Assert.Equal(AcquireDatabase.Migrations.Count, db.Version);
                var store = new NotifyStore(db);
                store.SetMeta("k", "v");
                var bytes = db.Snapshot()!;
                store.SetMeta("k", "changed");
                db.ReplaceWith(bytes);
                Assert.Equal("v", store.Meta("k"));
            }
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            // A database from a newer version is left alone and reported, never migrated down.
            using (var raw = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + path + ";Pooling=False"))
            {
                raw.Open();
                using var cmd = raw.CreateCommand();
                cmd.CommandText = "PRAGMA user_version=99;";
                cmd.ExecuteNonQuery();
            }
            using (var newer = new AcquireDatabase(path))
            {
                Assert.False(newer.Available);
                Assert.Contains("newer", newer.UnavailableReason, StringComparison.Ordinal);
                Assert.Throws<InvalidOperationException>(() => new NotifyStore(newer).Meta("k"));
            }
            Assert.True(AcquireDatabase.IsDatabaseFile("acquire.db-wal"));
            Assert.False(AcquireDatabase.IsDatabaseFile("acquire.dbx"));
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public async Task TheFeedTakesInterestOnlyInFollowedOrRequestedTitles()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        // The first scan of Seerr made Emma's request a title of interest and took its first look.
        await rig.Service.TickAsync(default, force: true);
        rig.Service.ReadFeed();
        rig.Arrive(Dune);
        // A change of a title nobody is interested in is not looked at; Dune's is.
        rig.Feed.Bump(new[] { "movie:tmdb:1", ArrTitleKey.UserInbox(rig.Emma.UserId) });
        rig.Service.ReadFeed();
        await rig.Service.TickAsync(default, force: true);
        Assert.Empty(rig.Inbox(rig.Emma));
        rig.Feed.Bump(new[] { Dune });
        rig.Service.ReadFeed();
        await rig.Service.TickAsync(default, force: true);
        Assert.Equal("ready", Assert.Single(rig.Inbox(rig.Emma)).Kind);
    }

    // ================================================================== review round 1

    [Fact]
    public async Task ATwoEpisodePremiereIsNotAWholeSeasonAndAnUnknownSeasonLengthNeverIs()
    {
        // Season 3 of Severance has ten episodes (Sonarr); the first two arrive together.
        using var rig = await Started(r => r.Sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 3, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = 2, ["episodeFileCount"] = 2, ["totalEpisodeCount"] = 10 } }));
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddSeason(series, new JfSeason { ItemId = Guid.NewGuid(), Season = 3 });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Severance)!, true, default));
        for (var n = 1; n <= 2; n++) rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 3, Episode = n, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        var premiere = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("many", "2"), (Params(premiere.Payload)["mode"], Params(premiere.Payload)["count"]));
        Assert.Equal(series.ToString("N"), premiere.ItemId);

        // A season Sonarr doesn't know the length of (Season 4, three episodes at once) reads "3 new episodes".
        for (var n = 1; n <= 3; n++) rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 4, Episode = n, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Equal("many", Params(rig.Inbox(rig.Emma)[0].Payload)["mode"]);
    }

    /// <summary>Adds a 4K Sonarr (role 4k) holding Severance in its own folder, before anything is read.</summary>
    internal static FakeArr.Host FourKSonarr(Rig r)
    {
        var host = r.Arr.Add("sonarr4k.lan", "Sonarr");
        r.Arr.Configure(
            ("RadarrZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"),
            ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"),
            ("Sonarr4kZ", ArrKind.Sonarr, "http://sonarr4k.lan:8989", "SONARR4K-KEY-0123456789"));
        var list = JsonNode.Parse(r.Config.SonarrInstances)!.AsArray();
        foreach (var row in list)
        {
            if ((string?)row!["Name"] == "Sonarr4kZ") row["Role"] = "4k";
        }
        r.Config.SonarrInstances = list.ToJsonString();
        var series = FakeArr.SeriesRow(9, 371980, "Severance");
        series["path"] = "/data/tv4k/Severance";
        host.Series.Add(series);
        return host;
    }

    [Fact]
    public async Task AFourKSeasonRequestIsToldAboutTheFourKEpisodesOnceNotTheStandardOnes()
    {
        // Emma asks for Season 2 of Severance in 4K. The standard copy already has S2E1.
        using var rig = await Started(r =>
        {
            FourKSonarr(r);
            r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
        });
        var hd = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = hd, Path = "/media/tv/Severance", LibraryName = "Shows", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        await rig.Step(Severance);
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, Severance, "eps4k"));

        // A standard episode of the season arrives: not what she asked for.
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Empty(rig.Inbox(rig.Emma));

        // The 4K copy's S2E1 arrives: told once, linked to the 4K episode.
        var uhd = Guid.NewGuid();
        var episode = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = uhd, Path = "/media/tv4k/Severance", LibraryName = "Shows 4K", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(uhd, new JfEpisode { ItemId = episode, Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        // Its file's own dimensions make it the 4K edition (D44: never the folder's Sonarr).
        rig.View.AddSource(episode, 3840, 2160);
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        await rig.Step(Severance);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        var p = Params(told.Payload);
        Assert.Equal(("single", "2", "1", "4k", episode.ToString("N")), (p["mode"], p["season"], p["episode"], p["variant"], told.ItemId));
    }

    [Fact]
    public async Task UnderSeriesGroupingAFourKSeasonRequestIsNeverToldAboutTheStandardFoldersEpisodes()
    {
        // Edition round 13 (physical reads): the standard and 4K folders of Severance in one library, which Jellyfin's
        // automatic series grouping shows as one show; its grouped lists of the 4K series item hold the standard folder's
        // episodes too. Emma asks for Season 2 in 4K; the 4K watch reads the 4K folder alone.
        using var rig = await Started(r =>
        {
            FourKSonarr(r);
            r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
        });
        var key = TitleKey.Parse(Severance)!;
        var old = rig.Arr.Now.UtcDateTime.AddDays(-30);
        var hd = Guid.NewGuid();
        var uhd = Guid.NewGuid();
        rig.View.AddCopy(key, new JfCopy { ItemId = hd, Path = "/media/tv/Severance", LibraryName = "Shows", DateCreated = old });
        rig.View.AddCopy(key, new JfCopy { ItemId = uhd, Path = "/media/tv4k/Severance", LibraryName = "Shows", DateCreated = old });
        rig.View.GroupSeries(hd, uhd);
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = old });
        await rig.Step(Severance);
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, Severance, "eps4k"));

        // A standard episode arrives in the standard folder: not what she asked for.
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Empty(rig.Inbox(rig.Emma));

        // The 4K folder's S2E1 arrives (the standard folder had S2E1 all along): told once, linked to the 4K episode.
        var episode = Guid.NewGuid();
        rig.View.AddEpisode(uhd, new JfEpisode { ItemId = episode, Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        // Its file's own dimensions make it the 4K edition (D44: never the folder's Sonarr).
        rig.View.AddSource(episode, 3840, 2160);
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        await rig.Step(Severance);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        var p = Params(told.Payload);
        Assert.Equal(("single", "2", "1", "4k", episode.ToString("N")), (p["mode"], p["season"], p["episode"], p["variant"], told.ItemId));
    }

    [Fact]
    public async Task UnderOneLinkedLibraryAFourKSeasonRequestIsToldOnlyAboutTheFourKSonarrsOwnFolder()
    {
        // Edition round 13, found live: one library holds both folders and both Sonarrs are linked to it, each mapped to its
        // own folder (the same title folder name in each). The 4K watch follows the copy the 4K Sonarr owns, its exact
        // mapped folder (as the status does), never every copy of its linked library.
        const string library = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
        using var rig = await Started(r =>
        {
            FourKSonarr(r);
            var rows = JsonNode.Parse(r.Config.SonarrInstances)!.AsArray();
            foreach (var row in rows)
            {
                var fourK = (string?)row!["Role"] == "4k";
                row["LinkedLibraryIds"] = new JsonArray(library);
                row["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = fourK ? "/data/tv4k" : "/data/tv", ["JellyfinPath"] = fourK ? "/media/shared/uhd" : "/media/shared/tv" });
            }
            r.Config.SonarrInstances = rows.ToJsonString();
            r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
        });
        var key = TitleKey.Parse(Severance)!;
        var old = rig.Arr.Now.UtcDateTime.AddDays(-30);
        var hd = Guid.NewGuid();
        var uhd = Guid.NewGuid();
        rig.View.AddCopy(key, new JfCopy { ItemId = hd, Path = "/media/shared/tv/Severance", LibraryId = library, LibraryName = "Shared", DateCreated = old });
        rig.View.AddCopy(key, new JfCopy { ItemId = uhd, Path = "/media/shared/uhd/Severance", LibraryId = library, LibraryName = "Shared", DateCreated = old });
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = old });
        await rig.Step(Severance);

        // The standard folder's S2E2 arrives: not what she asked for.
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Empty(rig.Inbox(rig.Emma));

        // The 4K folder's S2E1 arrives: told, linked to the 4K episode.
        var episode = Guid.NewGuid();
        rig.View.AddEpisode(uhd, new JfEpisode { ItemId = episode, Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        // Its file's own dimensions make it the 4K edition (D44: never the folder's Sonarr).
        rig.View.AddSource(episode, 3840, 2160);
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        await rig.Step(Severance);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("1", "4k", episode.ToString("N")), (Params(told.Payload)["episode"], Params(told.Payload)["variant"], told.ItemId));
    }

    [Fact]
    public async Task UnderSeriesGroupingAFourKArrivalGoneBeforeItsBatchIsSentIsNeverToldAsTheStandardFoldersEpisode()
    {
        // The 4K folder's S2E2 arrives and is batched for Emma's 4K request; before the batch goes out the 4K file is gone
        // and the grouped standard folder gets its own S2E2. The batch checks the 4K folder alone: nothing to tell.
        using var rig = await Started(r =>
        {
            FourKSonarr(r);
            r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
        });
        var key = TitleKey.Parse(Severance)!;
        var old = rig.Arr.Now.UtcDateTime.AddDays(-30);
        var hd = Guid.NewGuid();
        var uhd = Guid.NewGuid();
        rig.View.AddCopy(key, new JfCopy { ItemId = hd, Path = "/media/tv/Severance", LibraryName = "Shows", DateCreated = old });
        rig.View.AddCopy(key, new JfCopy { ItemId = uhd, Path = "/media/tv4k/Severance", LibraryName = "Shows", DateCreated = old });
        rig.View.GroupSeries(hd, uhd);
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = old });
        await rig.Step(Severance);
        rig.View.AddEpisode(uhd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);

        rig.View.EpisodesBySeries[uhd].RemoveAll(e => e.Episode.Season == 2 && e.Episode.Episode == 2);
        var standard = Guid.NewGuid();
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = standard, Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.DoesNotContain(rig.Inbox(rig.Emma), n => n.ItemId == standard.ToString("N") || Params(n.Payload).GetValueOrDefault("episodeItems")?.Contains(standard.ToString()) == true);
        Assert.Empty(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task AFourKSeasonRequestHeldOnlyByTheFourKSonarrIsNeverToldAboutTheStandardCopy()
    {
        // Only the 4K Sonarr has Severance (its own folder, no links or mappings). The standard
        // copy in Jellyfin can't be told apart from a 4K one by any rule, so it never counts as it.
        using var rig = await Started(r =>
        {
            FourKSonarr(r);
            r.Sonarr.Series.RemoveAll(x => (int?)x["tvdbId"] == 371980);
            r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
        });
        var hd = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = hd, Path = "/media/tv/Severance", LibraryName = "Shows", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        await rig.Step(Severance);
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        await rig.Step(Severance);
        Assert.Empty(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task AFourKSeasonRequestWithNoFourKSonarrIsToldOnlyAboutTheCopySeerrMatchedItTo()
    {
        // Jellyfin Enhanced watches only a standard Sonarr; Seerr sends 4K requests to one it doesn't
        // watch. Emma asks for Season 2 of Severance in 4K; Seerr names the Jellyfin item of the 4K copy. Only a file with
        // 4K dimensions is her arrival (edition round 19 part B), wherever it is; the HD copy's files are not.
        var uhd = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
            r.Seerr.Requests[^1]["media"]!["jellyfinMediaId4k"] = uhd.ToString("N");
        });
        var hd = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = hd, Path = "/data/tv/Severance", LibraryName = "Shows", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        await rig.Step(Severance);
        // HD episodes of Season 2 arrive (someone else's HD request): not what she asked for.
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(hd, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        await rig.Step(Severance);
        Assert.Empty(rig.Inbox(rig.Emma));

        // The 4K copy Seerr named gets S2E1: told, linked to that episode.
        var episode = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = uhd, Path = "/srv/uhd/Severance", LibraryName = "Shows 4K", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(uhd, new JfEpisode { ItemId = episode, Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        // Its file's own dimensions make it the 4K edition (D44: never the folder's Sonarr).
        rig.View.AddSource(episode, 3840, 2160);
        await rig.Step(Severance);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        await rig.Step(Severance);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        var p = Params(told.Payload);
        Assert.Equal(("single", "2", "1", "4k", episode.ToString("N")), (p["mode"], p["season"], p["episode"], p["variant"], told.ItemId));
    }

    [Fact]
    public async Task ReadyIsToldOncePerJellyfinItemWhicheverIdsTheTitleIsKnownBy()
    {
        // 12 Angry Men: no arr holds it. Emma asked for it in Seerr (TMDB 389, IMDb tt0050083) and
        // follows it from a page that knows it by IMDb only.
        const string tmdb = "movie:tmdb:389";
        const string imdb = "movie:imdb:tt0050083";
        // Sam follows another film nobody (no arr, no Seerr) can tie together, under both its ids.
        const string otherTmdb = "movie:tmdb:777";
        const string otherImdb = "movie:imdb:tt0000777";
        using var rig = await Started(r =>
        {
            var request = FakeSeerr.Request(40, "movie", 389, 2, r.Emma.UserId, Asked, userName: "Emma");
            request["media"]!["imdbId"] = "tt0050083";
            r.Seerr.Requests.Add(request);
        });
        rig.Phones(rig.Emma, rig.Sam);
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(imdb)!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(otherTmdb)!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(otherImdb)!, true, default));
        await rig.Step(tmdb, imdb, otherTmdb, otherImdb);
        // One Jellyfin item each, carrying both ids.
        var item = Guid.NewGuid();
        var other = Guid.NewGuid();
        foreach (var key in new[] { tmdb, imdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = item, Path = "/media/12 Angry Men", LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime });
        foreach (var key in new[] { otherTmdb, otherImdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = other, Path = "/media/Other", LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        await rig.Step(tmdb, imdb, otherTmdb, otherImdb);
        await rig.Step(imdb, tmdb, otherImdb, otherTmdb);

        var emma = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal((tmdb, item.ToString("N")), (emma.Key, emma.ItemId));
        // Seerr knows both ids: Emma's IMDb look is the TMDB title's (one watch state).
        Assert.Null(rig.NotifyStore.Watch(rig.Emma.UserId, imdb, "m"));
        // Two watch states for Sam's film, one notification: the item is the same.
        Assert.Equal(other.ToString("N"), Assert.Single(rig.Inbox(rig.Sam)).ItemId);
        // Phones and e-mail follow the inbox: one each per person.
        Assert.Equal(2, rig.Pushes.Count);
        Assert.Equal(2, rig.Mail.Sent.Count);
    }

    [Fact]
    public async Task AFailureBeforeTheNotificationExistsLeavesTheEventForTheNextLook()
    {
        // A movie no arr or Seerr names: its title comes from Jellyfin, whose lookup fails once.
        const string key = "movie:tmdb:4242";
        using var rig = await Started();
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(key)!, true, default));
        rig.Users.FailItemName = true;
        rig.Arrive(key);
        await rig.Step(key);
        Assert.Empty(rig.Inbox(rig.Emma));
        rig.Users.FailItemName = false;
        await rig.Step(key);
        Assert.Equal(("ready", "Jellyfin Name"), (Assert.Single(rig.Inbox(rig.Emma)).Kind, Params(rig.Inbox(rig.Emma)[0].Payload)["title"]));

        // The same for an episode batch whose window closes while the library can't be read.
        const string show = "tv:tvdb:4243";
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(show)!, true, default));
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        rig.Users.FailItemName = true;
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Emma));
        rig.Users.FailItemName = false;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.Step();
        var batch = rig.Inbox(rig.Emma)[0];
        Assert.Equal(("episodes", "single", "2"), (batch.Kind, Params(batch.Payload)["mode"], Params(batch.Payload)["episode"]));
        Assert.Null(rig.NotifyStore.Batch(rig.Emma.UserId, show));
    }

    [Fact]
    public async Task ABatchIsCheckedAgainForTheViewerWhenItsWindowCloses()
    {
        // Emma follows Severance; two episodes open a batch; then she loses the library.
        using var rig = await Started();
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Severance)!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(Severance)!, true, default));
        var hidden = Guid.NewGuid();
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = hidden, Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        // Within the window: the series goes to a library only the administrator opens, and Sam's
        // parental limit now hides episode 2.
        rig.View.CopiesByKey[Severance] = new() { (new JfCopy { ItemId = series, Path = "/tv/Severance" }, new HashSet<Guid> { rig.Admin.UserId, rig.Sam.UserId }) };
        var list = rig.View.EpisodesBySeries[series];
        var i = list.FindIndex(e => e.Episode.ItemId == hidden);
        list[i] = (list[i].Episode, new HashSet<Guid> { rig.Admin.UserId });
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Null(rig.NotifyStore.Batch(rig.Emma.UserId, Severance));
        var sam = Assert.Single(rig.Inbox(rig.Sam));
        Assert.Equal(("single", "1"), (Params(sam.Payload)["mode"], Params(sam.Payload)["episode"]));
    }

    [Fact]
    public async Task AnAdministratorsAlertIsNotSentToSomeoneWhoIsNoLongerOne()
    {
        using var rig = await Started();
        rig.Phones(rig.Admin);
        // Quiet hours hold the alert; meanwhile the administrator is made a normal user.
        rig.Prefs(rig.Admin, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 1, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Equal("approval", Assert.Single(rig.Inbox(rig.Admin)).Kind);
        rig.Users.AdminIds.Clear();
        rig.Prefs(rig.Admin, p => p.QuietHours = false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Step();
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        var stats = rig.NotifyStore.DeliveryStats(rig.Arr.Now);
        Assert.Equal((0, 0), (stats.Pending, stats.Failed24h));
        // Suppressed, not failed: nothing for the other administrators to look into.
        Assert.Empty(stats.Problems);
        // A family event still reaches the same person's phone.
        Assert.True(rig.Service.SendTest(rig.Admin.UserId));
        await rig.Step();
        Assert.Single(rig.Pushes);
    }

    [Theory]
    [InlineData(NotifyKind.Approval)]
    [InlineData(NotifyKind.Remind)]
    [InlineData(NotifyKind.StuckDigest)]
    [InlineData(NotifyKind.Ready)]
    [InlineData(NotifyKind.Episodes)]
    [InlineData(NotifyKind.Declined)]
    public void HiddenTitlesStayHiddenInEveryKindOfAlert(string kind)
    {
        var p = new Dictionary<string, string> { ["title"] = "Secret Film", ["user"] = "Emma", ["items"] = "Secret Film (Radarr, import_blocked)", ["count"] = "1", ["hours"] = "6", ["mode"] = "many", ["seasons"] = "1", ["contact"] = "Dad" };
        var hidden = NotifyTexts.Render(kind, p, hideTitles: true);
        Assert.DoesNotContain("Secret Film", hidden.Title + "\n" + hidden.Body, StringComparison.Ordinal);
        var shown = NotifyTexts.Render(kind, p, hideTitles: false);
        Assert.Contains("Secret Film", shown.Title + "\n" + shown.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RemindIsOncePerTitleWhicheverIdItCameUnderAndTwoTapsAtOnceSendOne()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning"));
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        Assert.Equal("ok", (await rig.Service.RemindAsync(rig.Emma, TitleKey.Parse("movie:imdb:tt693134")!, null, default)).Code);
        Assert.Equal("too_soon", (await rig.Service.RemindAsync(rig.Emma, TitleKey.Parse(Dune)!, null, default)).Code);
        Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "remind");
        // A day later, two taps at once: one reminder.
        rig.Arr.Now = rig.Arr.Now.AddHours(24).AddMinutes(1);
        var taps = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => rig.Service.RemindAsync(rig.Emma, TitleKey.Parse(Dune)!, null, default))));
        Assert.Single(taps, x => x.Code == "ok");
        Assert.Equal(2, rig.Inbox(rig.Admin).Count(n => n.Kind == "remind"));
    }

    [Fact]
    public async Task ARestoreLeavesTheRestoredDeliveriesAloneAndKeepsReadersSafe()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        rig.Prefs(rig.Emma, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        var backup = rig.Db.Snapshot()!;
        // The dispatcher has read the deliveries (now due) when a restore swaps the database in.
        var due = rig.NotifyStore.Due(rig.Arr.Now.AddDays(1), 10);
        Assert.Equal(2, due.Count);
        using var stop = new CancellationTokenSource();
        var reads = 0;
        var reader = Task.Run(() =>
        {
            while (!stop.IsCancellationRequested)
            {
                Assert.Single(rig.NotifyStore.Inbox(rig.Emma.UserId, null, 10));
                reads++;
            }
        });
        rig.Db.ReplaceWith(backup);
        rig.Db.ReplaceWith(backup);
        stop.Cancel();
        await reader;
        Assert.True(reads > 0);
        // The sends finish after the restore: the restored rows (same ids) are not touched.
        Assert.All(due, d => Assert.False(rig.NotifyStore.Finish(d.Id, true, null, null, rig.Arr.Now, d.Generation)));
        Assert.Equal(2, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
        // Read again under the new generation, they can be finished.
        var again = rig.NotifyStore.Due(rig.Arr.Now.AddDays(1), 10);
        Assert.All(again, d => Assert.True(rig.NotifyStore.Finish(d.Id, true, null, null, rig.Arr.Now, d.Generation)));
        Assert.Equal(0, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
        // Not a database: refused, the live one untouched.
        Assert.ThrowsAny<Exception>(() => rig.Db.ReplaceWith(System.Text.Encoding.UTF8.GetBytes("not a database at all, just text")));
        Assert.Single(rig.Inbox(rig.Emma));
    }

    // Quiet hours all day in UTC: phone and e-mail held until they are switched off.
    private static void QuietAllDay(Rig rig, StatusViewer user, bool on = true)
        => rig.Prefs(user, p => { p.QuietHours = on; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });

    [Fact]
    public async Task ADisabledUserIsToldNothingAndTheirQueuedAlertsAreSuppressedNotFailed()
    {
        const string other = "movie:tmdb:4242";
        using var rig = await Started(r =>
        {
            r.Request(1, 693134, r.Emma);
            r.Request(2, 4242, r.Sam);
        });
        rig.Phones(rig.Emma, rig.Sam);
        QuietAllDay(rig, rig.Sam);
        await rig.Step(Dune, other);
        // Emma's account is disabled (the usual way to cut someone off): her film arriving tells her nothing.
        rig.Users.Disabled.Add(rig.Emma.UserId);
        rig.Arrive(Dune);
        rig.Arrive(other);
        await rig.Step(Dune, other);
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Equal("ready", Assert.Single(rig.Inbox(rig.Sam)).Kind);
        Assert.Empty(rig.Pushes);
        // Sam's alerts were held by quiet hours; he is disabled before they end: never sent, not a failure.
        rig.Users.Disabled.Add(rig.Sam.UserId);
        QuietAllDay(rig, rig.Sam, on: false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Step();
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        var stats = rig.NotifyStore.DeliveryStats(rig.Arr.Now);
        Assert.Equal((0, 0, 0), (stats.Pending, stats.Sent24h, stats.Failed24h));
        Assert.Empty(stats.Problems);
        // A decline of a disabled user's request isn't told either.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 1);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 693134, 3, rig.Emma.UserId, Asked, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Pushes);
    }

    [Fact]
    public async Task HeldAlertsAreCheckedAgainForTheRecipientWhenTheyAreFinallySent()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma, rig.Admin);
        QuietAllDay(rig, rig.Emma);
        QuietAllDay(rig, rig.Admin);
        await rig.Step(Dune);
        var item = rig.Arrive(Dune);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 4242, 1, rig.Sam.UserId, rig.Arr.Now.UtcDateTime, userName: "Sam"));
        await rig.Step(Dune);
        Assert.Equal("ready", Assert.Single(rig.Inbox(rig.Emma)).Kind);
        Assert.Contains(rig.Inbox(rig.Admin), n => n.Kind == "approval");
        // Overnight Dune moves to a library only the administrator opens, and the administrator
        // switches alerts to phone and e-mail off.
        rig.View.CopiesByKey[Dune] = new() { (new JfCopy { ItemId = item, Path = "/media/" + Dune, LibraryName = "Movies" }, new HashSet<Guid> { rig.Admin.UserId }) };
        QuietAllDay(rig, rig.Emma, on: false);
        rig.Prefs(rig.Admin, p => { p.QuietHours = false; p.AdminAlerts = false; });
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Step();
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        var stats = rig.NotifyStore.DeliveryStats(rig.Arr.Now);
        Assert.Equal((0, 0), (stats.Pending, stats.Failed24h));
        Assert.Empty(stats.Problems);
    }

    [Fact]
    public async Task AMailServerThatNeverAnswersFailsTheSendInTimeAndTheNextDeliveryStillGoesOut()
    {
        // A server that accepts and then says nothing (port 465's implicit TLS with STARTTLS chosen).
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var held = new List<System.Net.Sockets.TcpClient>();
        var accepting = Task.Run(async () =>
        {
            try
            {
                while (true) held.Add(await listener.AcceptTcpClientAsync());
            }
            catch (Exception)
            {
                // Stopped.
            }
        });
        try
        {
            using var rig = await Started(r => r.Request(1, 693134, r.Emma));
            rig.Phones(rig.Emma);
            rig.Config.ArrSmtpHost = "127.0.0.1";
            rig.Config.ArrSmtpPort = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
            rig.Config.ArrSmtpStartTls = false;
            using var dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(new SmtpMailTransport { Timeout = TimeSpan.FromSeconds(1) }), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View);
            await rig.Requests.RefreshAsync(default);
            await rig.Service.EvaluateAsync(new[] { Dune }, null, default);
            rig.Arrive(Dune);
            await rig.Service.EvaluateAsync(new[] { Dune }, null, default);
            Assert.Single(rig.Inbox(rig.Emma));

            var watch = System.Diagnostics.Stopwatch.StartNew();
            var run = dispatcher.RunOnceAsync(default);
            Assert.Same(run, await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(20))));
            Assert.Equal(2, await run);
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), watch.Elapsed.ToString());
            Assert.Single(rig.Pushes);
            var stats = rig.NotifyStore.DeliveryStats(rig.Arr.Now);
            Assert.Equal((1, 1), (stats.Pending, stats.Sent24h));
            var problem = Assert.Single(stats.Problems);
            Assert.Equal(("email", false), (problem.Channel, problem.Final));
        }
        finally
        {
            listener.Stop();
            await accepting;
            foreach (var c in held) c.Dispose();
        }
    }

    [Fact]
    public async Task EpisodesMergedIntoABatchWhileItIsBeingSentAreNotLost()
    {
        using var rig = await Started();
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Severance)!, true, default));
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        Assert.NotNull(rig.NotifyStore.Batch(rig.Emma.UserId, Severance));
        // While the closing batch is checked against the library, a look from a request route (Emma
        // follows from the series page) finds episode 2 and merges it into the batch.
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        var armed = true;
        rig.View.OnEpisodes = () =>
        {
            if (!armed) return;
            armed = false;
            rig.Service.EvaluateAsync(new[] { Severance }, rig.Emma.UserId, default).GetAwaiter().GetResult();
        };
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        rig.Service.FlushBatches(rig.Arr.Now);
        rig.View.OnEpisodes = null;
        Assert.False(armed);
        rig.Service.FlushBatches(rig.Arr.Now);
        var n = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "many", "2"), (n.Kind, Params(n.Payload)["mode"], Params(n.Payload)["count"]));
        Assert.Null(rig.NotifyStore.Batch(rig.Emma.UserId, Severance));
    }

    [Fact]
    public async Task ASingleEpisodeLinksToACopyTheViewerCanStillOpen()
    {
        using var rig = await Started();
        var a = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/A/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        var b = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/B/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        rig.View.AddCopy(TitleKey.Parse(Severance)!, a);
        rig.View.AddCopy(TitleKey.Parse(Severance)!, b);
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Severance)!, true, default));
        var inA = Guid.NewGuid();
        var inB = Guid.NewGuid();
        rig.View.AddEpisode(a.ItemId, new JfEpisode { ItemId = inA, Season = 2, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = inB, Season = 2, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        // The batch noted copy A's episode; during the window Emma loses library A but keeps B.
        rig.View.CopiesByKey[Severance] = new() { (a, new HashSet<Guid> { rig.Admin.UserId }), (b, null) };
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        var n = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("single", inB.ToString("N")), (Params(n.Payload)["mode"], n.ItemId));
    }

    [Fact]
    public async Task ATitleAskedForAgainAfterItWasRemovedIsToldAgainWhenReady()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        await rig.Step(Dune);
        var item = rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "ready");
        // Months later the administrator deletes it to free space (looked at while the request is still
        // there); then Seerr clears the media and the request.
        rig.Arr.Now = rig.Arr.Now.AddDays(60);
        rig.View.CopiesByKey.Clear();
        rig.View.Rev++;
        await rig.Step(Dune);
        Assert.NotEqual("ready", rig.NotifyStore.Watch(rig.Emma.UserId, Dune, "m")?.Stage);
        rig.Seerr.Requests.Clear();
        await rig.Step(Dune);
        // Emma asks for it again (a new request): when it is ready again she is told again, once.
        rig.Seerr.Requests.Add(FakeSeerr.Request(2, "movie", 693134, 2, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step(Dune);
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "ready");
        // Downloaded again to the same path: Jellyfin gives it the same item id.
        rig.View.AddCopy(TitleKey.Parse(Dune)!, new JfCopy { ItemId = item, Path = "/media/" + Dune, LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        await rig.Step(Dune);
        await rig.Step(Dune);
        Assert.Equal(2, rig.Inbox(rig.Emma).Count(n => n.Kind == "ready"));
        // An upgrade flapping under the same request is still told once.
        rig.View.CopiesByKey.Clear();
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Equal(2, rig.Inbox(rig.Emma).Count(n => n.Kind == "ready"));
    }

    // Fails every insert of one kind of notification (a database error at the worst moment).
    private static void FailInserts(Rig rig, string kind, bool on) => rig.Db.Write((c, t) =>
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = t;
        cmd.CommandText = on
            ? $"CREATE TRIGGER fail_{kind} BEFORE INSERT ON notifications WHEN NEW.kind='{kind}' BEGIN SELECT RAISE(ABORT, 'disk full'); END"
            : $"DROP TRIGGER fail_{kind}";
        return cmd.ExecuteNonQuery();
    });

    private static async Task ChecksSurvivingErrors(Rig rig)
    {
        for (var i = 0; i < 2; i++)
        {
            try
            {
                await rig.Service.AdminChecksAsync(default);
            }
            catch (Microsoft.Data.Sqlite.SqliteException)
            {
                // The alert could not be written this round.
            }
            await Task.Delay(100);
        }
    }

    [Fact]
    public async Task AnOutageAlertThatCouldNotBeWrittenIsToldNextRound()
    {
        using var rig = await Started();
        var radarr = rig.Arr.Hosts["radarr.lan"];
        radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(6);
        await Checks(rig);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(9);
        await Checks(rig);
        FailInserts(rig, NotifyKind.InstanceDown, on: true);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await ChecksSurvivingErrors(rig);
        Assert.Empty(rig.Inbox(rig.Admin));
        Assert.Null(rig.NotifyStore.Meta("down-told:" + rig.Arr.Instance("RadarrZ").Id));
        FailInserts(rig, NotifyKind.InstanceDown, on: false);
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal("instance_down", Assert.Single(rig.Inbox(rig.Admin)).Kind);
        // Its end: clearing the outage and telling it ended go together too.
        radarr.FailWith = 0;
        FailInserts(rig, NotifyKind.InstanceUp, on: true);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(30);
        await ChecksSurvivingErrors(rig);
        for (var i = 0; i < 100 && (await rig.Store.GetSystemAsync(rig.Arr.Instance("RadarrZ"), default)).Error != null; i++) await Task.Delay(50);
        await ChecksSurvivingErrors(rig);
        Assert.Single(rig.Inbox(rig.Admin));
        Assert.NotNull(rig.NotifyStore.Meta("down-told:" + rig.Arr.Instance("RadarrZ").Id));
        FailInserts(rig, NotifyKind.InstanceUp, on: false);
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal("instance_up", rig.Inbox(rig.Admin)[0].Kind);
        Assert.Null(rig.NotifyStore.Meta("down-told:" + rig.Arr.Instance("RadarrZ").Id));
    }

    [Fact]
    public async Task ADigestThatCouldNotBeWrittenIsSentLaterThatHour()
    {
        using var rig = await Started();
        var old = FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning");
        old["added"] = rig.Arr.Now.UtcDateTime.AddHours(-7).ToString("o");
        rig.Radarr.Queue.Add(old);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        // Stuck for hours since JE first saw it.
        rig.Arr.Now = rig.Arr.Now.AddHours(7);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        rig.Config.ArrNotifyDigestHour = TimeZoneInfo.ConvertTime(rig.Arr.Now, TimeZoneInfo.Local).Hour;
        FailInserts(rig, NotifyKind.StuckDigest, on: true);
        await ChecksSurvivingErrors(rig);
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");
        FailInserts(rig, NotifyKind.StuckDigest, on: false);
        await rig.Service.AdminChecksAsync(default);
        await rig.Service.AdminChecksAsync(default);
        Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "stuck_digest");
    }

    [Fact]
    public async Task WorkReadBeforeARestoreIsNotWrittenIntoTheRestoredDatabase()
    {
        using var rig = await Started();
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Severance)!, true, default));
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(Severance);
        var backup = rig.Db.Snapshot()!;
        // The batch is read; while it is checked against the library, the administrator restores a backup.
        var armed = true;
        rig.View.OnEpisodes = () =>
        {
            if (!armed) return;
            armed = false;
            rig.Db.ReplaceWith(backup);
        };
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        Assert.Equal(0, rig.Service.FlushBatches(rig.Arr.Now));
        Assert.False(armed);
        // Nothing composed from the old database landed in the restored one; the next round sends the restored batch.
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.NotNull(rig.NotifyStore.Batch(rig.Emma.UserId, Severance));
        Assert.Equal(1, rig.Service.FlushBatches(rig.Arr.Now));
        Assert.Equal("episodes", Assert.Single(rig.Inbox(rig.Emma)).Kind);
        // The same for the store's own guard: a write for an older generation is dropped.
        var before = rig.NotifyStore.Generation;
        rig.Db.ReplaceWith(rig.Db.Snapshot()!);
        Assert.False(rig.NotifyStore.InTransaction(before, tx => { tx.SetMeta("x", "1"); return true; }, false).Done);
        Assert.Null(rig.NotifyStore.Meta("x"));
    }
}
