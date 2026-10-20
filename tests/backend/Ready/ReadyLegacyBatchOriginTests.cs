using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using World = JE.Tests.ReadyProvenanceAndWaitsTests.World;

namespace JE.Tests;

/// <summary>
/// 4f round 11 (4f-r10-1): an episode batch stored before round 10 has no arrival on its members. Such a member takes ITS OWN
/// batch's start, before anything rewrites the batch: a merge keeps the earliest start for the merged row, so dating the members
/// after it handed the newer batch's episodes the older batch's start, and three days after the older one started they were
/// dropped as stale though they were still fresh. Two legacy batches minutes apart, one series under two ids (TVDB, TMDB),
/// merged at or before the older one's catch-up limit, either one surviving; controls on both sides of both limits.
/// </summary>
[Collection("Plugin singleton")]
public class ReadyLegacyBatchOriginTests
{
    private const string Tvdb = "tv:tvdb:4251";
    private const string Tmdb = "tv:tmdb:9251";

    private sealed record Legacy(World W, JfCopy A, JfCopy B, DateTimeOffset Start)
    {
        public DateTimeOffset Newer => Start.AddMinutes(5);
    }

    // Emma follows season 1 under the TVDB id (copy A) and season 2 under the TMDB id (copy B). S1E2 arrives at the start and is
    // batched under TVDB; S2E2 five minutes later under TMDB. Both batches are then put in the pre-round-10 shape (no member
    // arrival), as an upgraded server finds them, with their own starts and windows kept.
    private static async Task<Legacy> TwoLegacyBatches()
    {
        var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        var rig = w.Rig;
        var a = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show A", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        var b = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show B", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        rig.View.AddCopy(TitleKey.Parse(Tvdb)!, a);
        rig.View.AddCopy(TitleKey.Parse(Tmdb)!, b);
        rig.View.AddEpisode(a.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await w.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Tvdb + ":s1")!, true, default));
        Assert.Equal("ok", await w.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(Tmdb + ":s2")!, true, default));
        await w.Service.EvaluateAsync(new[] { Tvdb, Tmdb }, null, default);

        var start = rig.Arr.Now;
        rig.View.AddEpisode(a.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = start.UtcDateTime });
        await w.Service.EvaluateAsync(new[] { Tvdb }, null, default);
        rig.Arr.Now = start.AddMinutes(5);
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await w.Service.EvaluateAsync(new[] { Tmdb }, null, default);
        Assert.Equal(2L, w.Count("SELECT COUNT(*) FROM batches"));
        Undate(w, Tvdb, start);
        Undate(w, Tmdb, start.AddMinutes(5));
        return new Legacy(w, a, b, start);
    }

    // The pre-round-10 shape: the same batch without its members' arrivals.
    private static void Undate(World w, string key, DateTimeOffset expectedStart)
    {
        var (json, first, due) = w.Rig.NotifyStore.Batch(w.Rig.Emma.UserId, key)!.Value;
        Assert.Equal(expectedStart, first);
        var state = JsonNode.Parse(json)!.AsObject();
        foreach (var e in state["Episodes"]!.AsArray()) Assert.True(e!.AsObject().Remove("A"));
        w.Rig.NotifyStore.SetBatch(w.Rig.Emma.UserId, key, state.ToJsonString(), first, due);
    }

    // Notifications switched off before either window closes: the flushes leave both batches as they are.
    private static void SwitchedOff(Legacy l, DateTimeOffset at)
    {
        l.W.Rig.Config.ArrNotificationsEnabled = false;
        l.W.Rig.Arr.Now = at;
        l.W.Service.FlushBatches(at);
        Assert.Equal(0, l.W.Rows(l.W.Rig.Emma, NotifyKind.Episodes));
    }

    // The two ids turn out to be one series (copy A is seen under TMDB as well; under TVDB too when the older batch is the one
    // looked at), and a new episode arrives on the side looked at: that look merges the two open batches.
    private static async Task MergeWithANewEpisode(Legacy l, bool olderSurvives)
    {
        var rig = l.W.Rig;
        rig.View.AddCopy(TitleKey.Parse(Tmdb)!, l.A);
        if (olderSurvives)
        {
            rig.View.AddCopy(TitleKey.Parse(Tvdb)!, l.B);
            rig.View.AddEpisode(l.A.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
            await l.W.Service.EvaluateAsync(new[] { Tvdb }, null, default);
        }
        else
        {
            rig.View.AddEpisode(l.B.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
            await l.W.Service.EvaluateAsync(new[] { Tmdb }, null, default);
        }
        Assert.Equal(1L, l.W.Count("SELECT COUNT(*) FROM batches"));
    }

    private static (int Season, int Episode)[] Told(World w)
    {
        var json = (string)w.Rig.Db.Read(c => NotifyStore.Scalar(c, "SELECT payload FROM notifications WHERE kind='episodes'", Array.Empty<(string, object?)>(), null))!;
        var p = JsonSerializer.Deserialize<Dictionary<string, string>>(json)!;
        var items = JsonSerializer.Deserialize<List<JsonElement>>(p["episodeItems"])!;
        var told = items.Select(i => (i.GetProperty("Season").GetInt32(), i.GetProperty("Episode").GetInt32())).ToArray();
        Assert.Equal(told.Length.ToString(System.Globalization.CultureInfo.InvariantCulture), p["count"]);
        return told;
    }

    // Each stored member's arrival (Unix ms) by its number; null when it has none.
    private static Dictionary<(int, int), long?> Arrivals(World w, string key)
    {
        var json = w.Rig.NotifyStore.Batch(w.Rig.Emma.UserId, key)!.Value.Episodes;
        return JsonNode.Parse(json)!["Episodes"]!.AsArray().ToDictionary(
            e => (e!["S"]!.GetValue<int>(), e["E"]!.GetValue<int>()),
            e => e!["A"] is JsonNode a && a.GetValueKind() == JsonValueKind.Number ? a.GetValue<long>() : (long?)null);
    }

    private static void FlushOn(World w, DateTimeOffset at)
    {
        w.Rig.Config.ArrNotificationsEnabled = true;
        w.Rig.Arr.Now = at;
        w.Service.FlushBatches(at);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LegacyBatchesMergedPastTheOlderOnesLimitStillTellTheNewerOnesEpisode(bool olderSurvives)
    {
        // Off for three days: at three days and a minute after the older batch started, a new episode's look merges both, and
        // the flush right after tells the newer legacy batch's S2E2 (five minutes younger: still fresh) with the new episode;
        // only the older one's S1E2 is past the limit. The newer one's episode was dropped (it took the older batch's start).
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            SwitchedOff(l, l.Start.AddMinutes(16));
            var at = l.Start + NotificationService.ArrivalFreshFor + TimeSpan.FromMinutes(1);
            l.W.Rig.Config.ArrNotificationsEnabled = true;
            l.W.Rig.Arr.Now = at;
            await MergeWithANewEpisode(l, olderSurvives);
            FlushOn(l.W, at);

            Assert.Equal(1, l.W.Rows(l.W.Rig.Emma, NotifyKind.Episodes));
            Assert.Equal(olderSurvives ? new[] { (1, 3), (2, 2) } : new[] { (2, 2), (2, 3) }, Told(l.W));
            Assert.Equal(0L, l.W.Count("SELECT COUNT(*) FROM batches"));
        }
    }

    [Fact]
    public async Task LegacyBatchesMergedWhileOpenKeepEachMembersOwnStartAcrossTheOlderOnesLimit()
    {
        // Merged six minutes in (both windows still open; the newer TMDB batch survives, the older one's start becomes the merged
        // row's), then off for three days. Flushed at three days and three minutes: S2E2 (five minutes in) and S2E3 (six) are
        // fresh, S1E2 isn't. Every member was stored with its own batch's start at the merge; S2E2 took the older start.
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            l.W.Rig.Arr.Now = l.Start.AddMinutes(6);
            await MergeWithANewEpisode(l, olderSurvives: false);
            var arrivals = Arrivals(l.W, Tmdb);
            Assert.Equal(l.Start.ToUnixTimeMilliseconds(), arrivals[(1, 2)]);
            Assert.Equal(l.Newer.ToUnixTimeMilliseconds(), arrivals[(2, 2)]);
            Assert.Equal(l.Start.AddMinutes(6).ToUnixTimeMilliseconds(), arrivals[(2, 3)]);
            Assert.Equal(l.Start, l.W.Rig.NotifyStore.Batch(l.W.Rig.Emma.UserId, Tmdb)!.Value.FirstAt);

            SwitchedOff(l, l.Start.AddMinutes(16));
            FlushOn(l.W, l.Start + NotificationService.ArrivalFreshFor + TimeSpan.FromMinutes(3));
            Assert.Equal(new[] { (2, 2), (2, 3) }, Told(l.W));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AMergeDatesEveryUndatedMemberWithItsOwnBatchsStartWhicheverSurvives(bool olderSurvives)
    {
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            l.W.Rig.Arr.Now = l.Start.AddMinutes(6);
            await MergeWithANewEpisode(l, olderSurvives);
            var arrivals = Arrivals(l.W, olderSurvives ? Tvdb : Tmdb);
            Assert.Equal(l.Start.ToUnixTimeMilliseconds(), arrivals[(1, 2)]);
            Assert.Equal(l.Newer.ToUnixTimeMilliseconds(), arrivals[(2, 2)]);
        }
    }

    [Fact]
    public async Task ANewEpisodeJoiningALegacyBatchDatesItsUndatedMembersWithThatBatchsStart()
    {
        // No merge: S2E3 joins the TMDB legacy batch alone. Its old member is stored with the batch's own start.
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            l.W.Rig.Arr.Now = l.Start.AddMinutes(6);
            l.W.Rig.View.AddEpisode(l.B.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 3, DateCreated = l.W.Rig.Arr.Now.UtcDateTime });
            await l.W.Service.EvaluateAsync(new[] { Tmdb }, null, default);
            Assert.Equal(2L, l.W.Count("SELECT COUNT(*) FROM batches"));
            var arrivals = Arrivals(l.W, Tmdb);
            Assert.Equal(l.Newer.ToUnixTimeMilliseconds(), arrivals[(2, 2)]);
            Assert.Equal(l.Start.AddMinutes(6).ToUnixTimeMilliseconds(), arrivals[(2, 3)]);
            Assert.Equal(l.Newer, l.W.Rig.NotifyStore.Batch(l.W.Rig.Emma.UserId, Tmdb)!.Value.FirstAt);
        }
    }

    // ---- controls

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlLegacyBatchesMergedBeforeTheOlderOnesLimitAreToldWhole(bool olderSurvives)
    {
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            SwitchedOff(l, l.Start.AddMinutes(16));
            var at = l.Start + NotificationService.ArrivalFreshFor - TimeSpan.FromMinutes(1);
            l.W.Rig.Config.ArrNotificationsEnabled = true;
            l.W.Rig.Arr.Now = at;
            await MergeWithANewEpisode(l, olderSurvives);
            FlushOn(l.W, at);
            Assert.Equal(olderSurvives ? new[] { (1, 2), (1, 3), (2, 2) } : new[] { (1, 2), (2, 2), (2, 3) }, Told(l.W));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlLegacyBatchesMergedPastBothLimitsTellOnlyTheNewEpisode(bool olderSurvives)
    {
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            SwitchedOff(l, l.Start.AddMinutes(16));
            var at = l.Newer + NotificationService.ArrivalFreshFor + TimeSpan.FromMinutes(1);
            l.W.Rig.Config.ArrNotificationsEnabled = true;
            l.W.Rig.Arr.Now = at;
            await MergeWithANewEpisode(l, olderSurvives);
            FlushOn(l.W, at);
            Assert.Equal(olderSurvives ? new[] { (1, 3) } : new[] { (2, 3) }, Told(l.W));
        }
    }

    [Fact]
    public async Task ControlUnmergedLegacyBatchesEachKeepTheirOwnStartAcrossTheOlderOnesLimit()
    {
        // Never merged: flushed at three days and a minute after the older one started, the older is dropped untold and the
        // newer told alone.
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            SwitchedOff(l, l.Start.AddMinutes(16));
            FlushOn(l.W, l.Start + NotificationService.ArrivalFreshFor + TimeSpan.FromMinutes(1));
            Assert.Equal(new[] { (2, 2) }, Told(l.W));
            Assert.Equal(0L, l.W.Count("SELECT COUNT(*) FROM batches"));
        }
    }

    [Fact]
    public async Task ControlUnmergedLegacyBatchesBeforeEitherLimitAreBothTold()
    {
        var l = await TwoLegacyBatches();
        using (l.W)
        {
            SwitchedOff(l, l.Start.AddMinutes(16));
            FlushOn(l.W, l.Start + NotificationService.ArrivalFreshFor - TimeSpan.FromMinutes(1));
            Assert.Equal(2, l.W.Rows(l.W.Rig.Emma, NotifyKind.Episodes));
        }
    }

    [Fact]
    public void EveryStoredBatchIsReadThroughTheOneHelperThatDatesItsMembers()
    {
        // The sweep (4f-r10-1): an undated member gets its origin in one place, where a stored batch is read with its own row's
        // start. Every other read of a batch's JSON would be a place a legacy member could take another batch's start.
        var source = File.ReadAllText(Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Services", "Acquire", "Notify", "NotificationService.cs"));
        Assert.Equal(1, Occurrences(source, "Deserialize<BatchState>("));
        Assert.Contains("private static BatchState? ReadBatch(string json, DateTimeOffset firstAt)", source);
        Assert.Equal(0, Occurrences(source, ": started"));
    }

    private static int Occurrences(string text, string what)
    {
        var n = 0;
        for (var i = text.IndexOf(what, StringComparison.Ordinal); i >= 0; i = text.IndexOf(what, i + what.Length, StringComparison.Ordinal)) n++;
        return n;
    }
}
