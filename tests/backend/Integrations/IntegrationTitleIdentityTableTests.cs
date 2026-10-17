using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// One title identity across its ids (phase 4b, Q-4BFIX3-2). A series asked for before it reached Sonarr is known by its
/// TMDB id, later by its TVDB id; a movie by its IMDb id before Radarr has it. The ledger must treat every request for the
/// title as one title, whichever id it was asked by and in whichever order the ids became known: the table runs each path
/// (own dedup, someone else's ask and shared dispatch, keep-getting follow suppression, decline cooldown, approvals, a
/// deleted person, the Seerr import, My requests) for each alias order and state of the first request, and compares it with
/// the same path asked by one id throughout. Then existing split acquisitions are merged without losing or re-sending
/// anything. Production policy, ledger, outbox and Seerr backend over a synthetic Seerr and arr.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationTitleIdentityTableTests
{
    private const int Tmdb = 1731;
    private const int Tvdb = 99731;
    private const int Movie = 603;
    private const string Imdb = "tt0133093";
    private static readonly string SeriesTmdb = "tv:tmdb:" + Tmdb;
    private static readonly string SeriesTvdb = "tv:tvdb:" + Tvdb;
    private static readonly string MovieTmdb = "movie:tmdb:" + Movie;
    private static readonly string MovieImdb = "movie:imdb:" + Imdb;

    /// <summary>The order the title's ids became known in.</summary>
    public enum Order
    {
        /// <summary>A series asked for by its TMDB id; then Sonarr knows it by its TVDB id too.</summary>
        TmdbThenTvdb,
        /// <summary>A series asked for while Sonarr knows it (its TVDB id); then Sonarr no longer has it, and it's asked for by its TMDB id.</summary>
        TvdbThenTmdb,
        /// <summary>A movie asked for by its IMDb id; then Radarr knows it by its TMDB id too.</summary>
        ImdbThenTmdb,
    }

    /// <summary>The first request's state when the title is asked for again.</summary>
    public enum State
    {
        /// <summary>Sent to Seerr.</summary>
        Sent,
        /// <summary>Queued, not sent yet.</summary>
        Unsent,
        /// <summary>Waiting for an OK.</summary>
        Held,
    }

    internal sealed class Rig : IDisposable
    {
        public IntegrationRequestBackendsTests.SeerrLab Lab { get; } = new();
        public FakeJellyfinView View { get; } = new();
        public StatusViewer Admin { get; }
        public StatusViewer Admin2 { get; }
        public StatusViewer Kid { get; }
        public StatusViewer Manager { get; }
        public AcquireDatabase Db { get; }
        public RequestLedger Ledger { get; }
        public SeerrBackend Seerr { get; }
        public RequestPolicy Policy { get; }
        public TitleAliases Aliases { get; }
        public RequestService Service { get; private set; }
        public RequestOutbox Outbox { get; }
        public PluginConfiguration Config => Lab.Config;
        public FakeSeerr Fake => Lab.Seerr;

        public Rig()
        {
            Config.ArrRequestBackend = "seerr";
            Admin = View.AddUser(true);
            Admin2 = View.AddUser(true);
            Kid = View.AddUser(false);
            Manager = View.AddUser(false);
            Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                [Kid.UserId.ToString("N")] = new { Role = "Kid" },
                [Manager.UserId.ToString("N")] = new { Role = "Manager" },
            });
            Fake.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = Admin.UserId.ToString("N"), ["permissions"] = 2, ["displayName"] = "Admin" });
            Fake.Users.Add(new JsonObject { ["id"] = 12, ["jellyfinUserId"] = Admin2.UserId.ToString("N"), ["permissions"] = 2, ["displayName"] = "Admin 2" });
            Fake.Users.Add(new JsonObject { ["id"] = 10, ["jellyfinUserId"] = Kid.UserId.ToString("N"), ["permissions"] = 32, ["displayName"] = "Kid" });
            Fake.Users.Add(new JsonObject { ["id"] = 11, ["jellyfinUserId"] = Manager.UserId.ToString("N"), ["permissions"] = 32 | 16 | 8192, ["displayName"] = "Manager" });
            static JsonObject Season(int n, string aired) => new() { ["seasonNumber"] = n, ["episodeCount"] = 8, ["airDate"] = aired };
            Fake.Shows[Tmdb] = new JsonObject { ["id"] = Tmdb, ["seasons"] = new JsonArray(Season(1, "2020-01-01"), Season(2, "2021-01-01"), Season(3, "2027-03-01")) };
            Fake.Movies[Movie] = new JsonObject { ["id"] = Movie };
            Aliases = new TitleAliases(Lab.Arr.Store, null);
            Db = new AcquireDatabase(Path.Combine(Lab.Arr.Arr.Plugin.Core.Root, "identity.db"));
            Ledger = new RequestLedger(Db);
            // TMDB's find: a title nothing here holds yet is still found by its TVDB or IMDb id.
            Seerr = new SeerrBackend(Fake.Transport, Lab.Model, Aliases, () => Config, () => Lab.Now, Ledger.BindSeerrSend, null,
                (key, _) => Task.FromResult<int?>(key.ToString() switch { "tv:tvdb:99731" => Tmdb, "movie:imdb:tt0133093" => Movie, _ => null }));
            var router = new RequestBackendRouter(Lab.Arr.Direct, Seerr, () => Config);
            Policy = new RequestPolicy(View, Lab.Arr.Store, new ArrInstanceLibraries(Lab.Arr.Store, new FakeLibraryAccess()), Aliases, null!, Lab.Arr.Arr.Factory, router);
            Service = new RequestService(Ledger, Policy, View, new ArrChangeFeed(), () => Lab.Now, Aliases);
            var audit = new ArrAuditLog(Path.Combine(Lab.Arr.Arr.Plugin.Core.Root, "identity-audit.jsonl"), 100000, 1);
            Outbox = new RequestOutbox(Ledger, Policy, router, new RequestTitleLocks(), new ArrChangeFeed(), audit, () => Lab.Now);
        }

        /// <summary>A build from before the fix: requests stored by whichever id they were asked by.</summary>
        public void WithoutIdentity() => Service = new RequestService(Ledger, Policy, View, new ArrChangeFeed(), () => Lab.Now);

        /// <summary>The background pass that makes every title the ledger holds one identity.</summary>
        public RequestTitleIdentity Identity() => new(Ledger, Policy, Aliases, new ArrChangeFeed(), null, () => Lab.Now);

        // Sonarr holds the series (by its TVDB, TMDB and IMDb ids), or no longer does.
        public async Task Series(bool held)
        {
            Lab.Arr.Sonarr.Series.Clear();
            if (held)
                Lab.Arr.Sonarr.Series.Add(new JsonObject
                {
                    ["id"] = 77, ["tvdbId"] = Tvdb, ["tmdbId"] = Tmdb, ["title"] = "Followed", ["titleSlug"] = "followed", ["monitored"] = true, ["path"] = "/data/tv/Followed",
                    ["qualityProfileId"] = 4, ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true }, new JsonObject { ["seasonNumber"] = 2, ["monitored"] = false }),
                });
            Assert.True((await Lab.Arr.Store.RefreshLibraryNowAsync(Lab.Arr.Instance("Sonarr"), default)).Ok);
        }

        // Radarr holds the movie (by its TMDB and IMDb ids), or doesn't.
        public async Task Film(bool held)
        {
            Lab.Arr.Radarr.Movies.Clear();
            if (held) Lab.Arr.Radarr.Movies.Add(new JsonObject { ["id"] = 33, ["tmdbId"] = Movie, ["imdbId"] = Imdb, ["title"] = "The Matrix", ["monitored"] = true, ["hasFile"] = false, ["path"] = "/data/movies/The Matrix" });
            Assert.True((await Lab.Arr.Store.RefreshLibraryNowAsync(Lab.Arr.Instance("Radarr"), default)).Ok);
        }

        public Task<RequestOutcome> Ask(StatusViewer who, MutationInput input, bool held = false, string? client = null)
            => Service.CreateAsync(who.UserId, new(client ?? Guid.NewGuid().ToString("N"), input), default, held ? new RequestOrigin(RequestOrigin.InteractiveKind) { RequireApproval = true } : null);

        public T Scalar<T>(string sql) => Db.Read(c =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            return (T)Convert.ChangeType(cmd.ExecuteScalar()!, typeof(T), System.Globalization.CultureInfo.InvariantCulture);
        });

        public void Dispose()
        {
            Db.Dispose();
            Lab.Dispose();
        }
    }

    private static bool IsMovie(Order order) => order == Order.ImdbThenTmdb;

    private static MutationInput Input(string key, params int[] seasons)
        => key.StartsWith("movie:", StringComparison.Ordinal) ? new MutationInput { Key = key } : new MutationInput { Key = key, Scope = "seasons", Seasons = seasons.Length == 0 ? new[] { 1 } : seasons };

    // The ids the first and the second ask use, and what the arrs know before each (control: one id, known throughout).
    private static async Task<(string First, string Second)> Before(Rig rig, Order order, bool control)
    {
        if (IsMovie(order))
        {
            await rig.Film(control);
            return control ? (MovieTmdb, MovieTmdb) : (MovieImdb, MovieTmdb);
        }
        await rig.Series(control || order == Order.TvdbThenTmdb);
        return order == Order.TmdbThenTvdb && !control ? (SeriesTmdb, SeriesTvdb) : control ? (SeriesTvdb, SeriesTvdb) : (SeriesTvdb, SeriesTmdb);
    }

    // Between the two asks: the arrs learn the other id (TMDB first, IMDb first), or forget it (TVDB first).
    private static async Task Between(Rig rig, Order order, bool control)
    {
        rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
        if (IsMovie(order)) await rig.Film(true);
        else await rig.Series(order != Order.TvdbThenTmdb || control);
    }

    private static async Task<string> First(Rig rig, StatusViewer who, MutationInput input, State state, string? client = null)
    {
        var outcome = await rig.Ask(who, input, held: state == State.Held, client: client);
        Assert.True(outcome.HttpStatus == 201, outcome.Reason + ": " + outcome.Message);
        if (state == State.Sent) await rig.Outbox.TickAsync(default);
        Assert.Equal(state switch { State.Sent => "sent", State.Unsent => "queued", _ => "pending" }, rig.Ledger.Find(outcome.RequestId!)!.Status);
        return outcome.RequestId!;
    }

    // What the ledger holds for the title, as anyone can see it: one line per request, the number of acquisitions and of
    // stored keys, and what went to Seerr.
    private static string Summary(Rig rig, params string[] ids)
    {
        var lines = ids.Select((id, i) =>
        {
            var w = rig.Ledger.Find(id)!;
            return $"#{i}: {w.Status}/{w.Reason} follower={w.Follower} cost={w.Cost} jobs={rig.Ledger.ForWant(id).Count}";
        }).ToList();
        lines.Add("acquisitions=" + rig.Scalar<long>("SELECT COUNT(*) FROM acquisitions"));
        lines.Add("keys=" + rig.Scalar<long>("SELECT COUNT(DISTINCT title_key) FROM wants"));
        lines.Add("posts=" + rig.Fake.Posts.Count);
        return string.Join("\n", lines);
    }

    public static TheoryData<string, Order, State> Paths()
    {
        var rows = new TheoryData<string, Order, State>();
        foreach (var order in Enum.GetValues<Order>())
            foreach (var state in Enum.GetValues<State>())
            {
                rows.Add("own", order, state);
                rows.Add("retry", order, state);
                rows.Add("someone else", order, state);
                rows.Add("purge", order, state);
                rows.Add("import", order, state);
            }
        foreach (var order in Enum.GetValues<Order>())
        {
            rows.Add("decline cooldown", order, State.Held);
            rows.Add("approval", order, State.Held);
            if (!IsMovie(order)) foreach (var state in Enum.GetValues<State>()) rows.Add("follow", order, state);
        }
        return rows;
    }

    /// <summary>Each path behaves exactly as when the title is asked for by one id throughout.</summary>
    [Theory]
    [MemberData(nameof(Paths))]
    public async Task EveryPathTreatsTheTitleAsOneWhicheverIdItIsAskedBy(string path, Order order, State state)
    {
        var split = await Run(path, order, state, control: false);
        var same = await Run(path, order, state, control: true);
        Assert.Equal(same, split);
        Assert.Contains("acquisitions=1", split, StringComparison.Ordinal);
        Assert.Contains("keys=1", split, StringComparison.Ordinal);
    }

    private static async Task<string> Run(string path, Order order, State state, bool control)
    {
        using var rig = new Rig();
        var (first, second) = await Before(rig, order, control);
        switch (path)
        {
            case "own":
            {
                var id = await First(rig, rig.Admin, Input(first), state);
                await Between(rig, order, control);
                var again = await rig.Ask(rig.Admin, Input(second));
                var mine = rig.Service.List(rig.Admin.UserId, false);
                var rows = JsonNode.Parse(mine.Json)!["items"]!.AsArray().Count;
                return $"again={again.HttpStatus} same={again.RequestId == id} rows={rows}\n" + Summary(rig, id);
            }
            case "retry":
            {
                // The same ask sent again with its client id (a retry after a lost answer), as it was first sent.
                var id = await First(rig, rig.Admin, Input(first), state, client: "retry-1");
                await Between(rig, order, control);
                var again = await rig.Ask(rig.Admin, Input(first), held: state == State.Held, client: "retry-1");
                return $"again={again.HttpStatus}/{again.Reason} same={again.RequestId == id}\n" + Summary(rig, id);
            }
            case "someone else":
            {
                var id = await First(rig, rig.Admin, Input(first), state);
                await Between(rig, order, control);
                var other = await rig.Ask(rig.Admin2, Input(second));
                // One send serves both (shared dispatch), and nothing goes out twice.
                await rig.Outbox.TickAsync(default);
                return $"other={other.HttpStatus}/{other.Outcome}\n" + Summary(rig, id, other.RequestId!);
            }
            case "purge":
            {
                var id = await First(rig, rig.Manager, Input(first), state);
                await Between(rig, order, control);
                var other = await rig.Ask(rig.Admin2, Input(second));
                rig.Ledger.PurgeUser(rig.Manager.UserId);
                await rig.Outbox.TickAsync(default);
                var kept = rig.Ledger.Find(id) is { } w ? w.Status : "gone";
                return $"purged={kept}\n" + Summary(rig, other.RequestId!);
            }
            case "import":
            {
                var id = await First(rig, rig.Admin, Input(first), state);
                await Between(rig, order, control);
                // Seerr's own request for the title (by the other id), moved into Jellyfin Enhanced (the move learns each
                // title's ids first, as SeerrMigration does).
                RequestTitleIdentity.Learn(rig.Ledger, rig.Policy, rig.Aliases, null, Input(second).Key, rig.Lab.Now);
                var result = rig.Ledger.ImportSeerr("seerr-src", "digest", new[] { new ImportCandidate(rig.Admin.UserId, 501, Input(second), state == State.Held, rig.Lab.Now) },
                    new Dictionary<string, int>(), rig.Admin.UserId, "seerr", _ => RequestLedger.SeerrTargetKey(rig.Lab.Source), rig.Lab.Now, TimeSpan.FromDays(7));
                return $"imported={result.Imported} skipped={string.Join(",", result.Skipped.Select(kv => kv.Key + ":" + kv.Value))}\n" + Summary(rig, id);
            }
            case "decline cooldown":
            {
                var id = await First(rig, rig.Kid, Input(first), state);
                Assert.Equal(200, (await rig.Service.DeclineAsync(id, rig.Admin.UserId, "Not now.", default)).HttpStatus);
                await Between(rig, order, control);
                var again = await rig.Ask(rig.Kid, Input(second));
                return $"again={again.HttpStatus}/{again.Reason}\n" + Summary(rig, id);
            }
            case "approval":
            {
                var id = await First(rig, rig.Kid, Input(first), state);
                await Between(rig, order, control);
                // An edited approval names the title by the other id.
                var approved = await rig.Service.ApproveAsync(id, rig.Admin.UserId, new ApproveRequest(Input(second)), default);
                await rig.Outbox.TickAsync(default);
                return $"approved={approved.HttpStatus}/{approved.Reason}\n" + Summary(rig, id);
            }
            default:
            {
                // Keep getting new episodes from season 2 (sent); someone else asks for season 3 by the other id; season 3
                // starts: it is theirs, not followed again.
                var keep = (await rig.Ask(rig.Admin, new MutationInput { Key = first, Scope = "future", Seasons = new[] { 2 } })).RequestId!;
                await rig.Outbox.TickAsync(default);
                await Between(rig, order, control);
                var other = await rig.Ask(rig.Admin2, Input(second, 3), held: state == State.Held);
                if (state == State.Sent) await rig.Outbox.TickAsync(default);
                rig.Fake.Shows[Tmdb]["seasons"]!.AsArray()[2]!["airDate"] = "2026-10-01";
                rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
                var follower = new FutureSeasonCharges(rig.Lab.Arr.Store, rig.Ledger, rig.Policy, rig.Lab.Arr.Arr.Factory, new ArrChangeFeed(), rig.Aliases, null, () => rig.Lab.Now, rig.Seerr, rig.Lab.Model, new RequestOutboxSignal());
                var followed = await follower.FollowSeerrAsync(default);
                return $"followed={followed}\n" + Summary(rig, keep, other.RequestId!);
            }
        }
    }

    // ------------------------------------------------------------------ split acquisitions already in the ledger

    public static TheoryData<State, State> Splits()
    {
        var rows = new TheoryData<State, State>();
        foreach (var first in Enum.GetValues<State>())
            foreach (var second in Enum.GetValues<State>()) rows.Add(first, second);
        return rows;
    }

    /// <summary>
    /// A ledger an earlier build split (the series asked for by its TMDB id, then by its TVDB id once Sonarr had it, two
    /// acquisitions) is merged into one title when the background pass learns the ids: every person's request is kept, with
    /// its charges, pool, history and notices; a later request that the earlier one already covers follows it and gets its
    /// charge back (nothing is charged twice); nothing that went out is sent again; and it happens once.
    /// </summary>
    [Theory]
    [MemberData(nameof(Splits))]
    public async Task SplitAcquisitionsAlreadyInTheLedgerAreMergedKeepingEveryRequestAndSendingNothingAgain(State firstState, State secondState)
    {
        using var rig = new Rig();
        rig.WithoutIdentity();
        await rig.Series(false);
        var first = await First(rig, rig.Admin, Input(SeriesTmdb), firstState);
        await rig.Series(true);
        rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
        var secondAsk = await rig.Ask(rig.Admin2, Input(SeriesTvdb), held: secondState == State.Held);
        Assert.True(secondAsk.HttpStatus == 201, secondAsk.Reason + ": " + secondAsk.Message);
        var second = secondAsk.RequestId!;
        if (secondState == State.Sent)
        {
            // Only the second goes out now: the first (when it is queued) stays unsent through this pass.
            void Delay(long ms) => rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE jobs SET next_attempt=next_attempt+$ms WHERE want_id=$w", ("$ms", ms), ("$w", first)));
            Delay(3_600_000);
            await rig.Outbox.TickAsync(default);
            Delay(-3_600_000);
        }
        Assert.Equal(2L, rig.Scalar<long>("SELECT COUNT(*) FROM acquisitions"));
        var audits = rig.Scalar<long>("SELECT COUNT(*) FROM request_audit");
        var notices = rig.Scalar<long>("SELECT COUNT(*) FROM request_notices");
        var charged = rig.Scalar<long>("SELECT COALESCE(SUM(cost),0) FROM reservations WHERE state='charged'");
        var posts = rig.Fake.Posts.Count;

        // The fixed build's background pass.
        Assert.Equal(1, rig.Identity().Reconcile());
        Assert.Equal(0, rig.Identity().Reconcile());

        Assert.Equal(1L, rig.Scalar<long>("SELECT COUNT(*) FROM acquisitions"));
        Assert.Equal(SeriesTvdb, rig.Scalar<string>("SELECT DISTINCT title_key FROM wants"));
        Assert.Equal(SeriesTvdb, rig.Scalar<string>("SELECT canonical FROM title_aliases WHERE alias='" + SeriesTmdb + "'"));
        var a = rig.Ledger.Find(first)!;
        var b = rig.Ledger.Find(second)!;
        Assert.Equal((SeriesTvdb, SeriesTvdb), (a.Input.Key, b.Input.Key));
        Assert.All(rig.Ledger.ForWant(first).Concat(rig.Ledger.ForWant(second)), j => Assert.Equal((SeriesTvdb, j.Input.Fingerprint), (j.Input.Key, j.Fingerprint)));
        // History and notices kept (the merge adds its own audit rows).
        Assert.True(rig.Scalar<long>("SELECT COUNT(*) FROM request_audit") >= audits);
        Assert.True(rig.Scalar<long>("SELECT COUNT(*) FROM request_notices") >= notices);
        // One of the two follows the other, as it would have had the title been one from the start: what went out stays the
        // owner (it was sent); else the earlier ask owns it, and a waiting ask covered by a queued one is released. The
        // follower is free: its charge is given back (a held one was never counted) and its unsent work cancelled.
        var (followerIsSecond, chargeBack, newPosts) = (firstState, secondState) switch
        {
            (State.Sent, State.Sent) => (true, 1, 0),
            (State.Sent, State.Unsent) => (true, 1, 0),
            (State.Sent, State.Held) => (true, 0, 0),
            (State.Unsent, State.Sent) => (false, 1, 0),
            (State.Unsent, State.Unsent) => (true, 1, 1),
            (State.Unsent, State.Held) => (true, 0, 1),
            (State.Held, State.Sent) => (false, 0, 0),
            (State.Held, State.Unsent) => (false, 0, 1),
            _ => (true, 0, 0),
        };
        Assert.Equal((followerIsSecond, !followerIsSecond), (b.Follower, a.Follower));
        Assert.Equal(0, (followerIsSecond ? b : a).Cost);
        Assert.Equal(charged - chargeBack, rig.Scalar<long>("SELECT COALESCE(SUM(cost),0) FROM reservations WHERE state='charged'"));
        // Nothing that went out is sent again, and nothing is sent twice: one send at most, for what never went out.
        await rig.Outbox.TickAsync(default);
        Assert.Equal(posts + newPosts, rig.Fake.Posts.Count);
        Assert.All(new[] { rig.Ledger.Find(first)!, rig.Ledger.Find(second)! }, w => Assert.Contains(w.Status, new[] { "sent", "pending", "queued" }));
        // My requests (an administrator sees both people's) shows the title once.
        var mine = JsonNode.Parse(rig.Service.List(rig.Admin2.UserId, false).Json)!["items"]!.AsArray();
        Assert.Single(mine);
    }

    /// <summary>A schema-4 database from before the identity work gets its alias table once, in the same extension.</summary>
    [Fact]
    public void ASchemaFourDatabaseWithoutTheAliasTableGetsItOnce()
    {
        var root = Path.Combine(Path.GetTempPath(), "je-4bid-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var path = Path.Combine(root, "acquire.db");
            using (var db = new AcquireDatabase(path)) Assert.True(db.Available);
            using (var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
            {
                c.Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = "DROP TABLE title_aliases;";
                cmd.ExecuteNonQuery();
            }
            using (var db = new AcquireDatabase(path))
            {
                Assert.True(db.Available);
                Assert.Equal(1L, db.Read(c =>
                {
                    using var cmd = c.CreateCommand();
                    cmd.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='title_aliases'";
                    return (long)cmd.ExecuteScalar()!;
                }));
            }
            using (var again = new AcquireDatabase(path)) Assert.True(again.Available);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }
}
