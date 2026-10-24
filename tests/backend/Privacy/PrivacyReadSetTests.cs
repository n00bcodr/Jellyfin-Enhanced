using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Moq;

namespace JE.Tests;

/// <summary>
/// The read-set and the byte boundary by their own surface (review round 23's shape): every host read a gated answer's
/// verdict makes is in that answer's read-set (a read outside the accessor is caught), a progress save moves only the
/// answers that read the position, and every writer of a gated answer's bytes checks the guard.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReadSetTests
{
    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    /// <summary>The host reads an attempt made, each checked against that attempt's read-set once the attempt is done.</summary>
    private sealed class Reads
    {
        private readonly List<(PrivacyReadSet Set, string What, Func<PrivacyReadSet, bool> Held)> _seen = new();

        public void Add(PrivacyReadSet set, string what, Func<PrivacyReadSet, bool> held) { lock (_seen) _seen.Add((set, what, held)); }

        /// <summary>The reads whose value is not a fact of the attempt that made them.</summary>
        public List<string> Outside() { lock (_seen) return _seen.Where(r => !r.Held(r.Set)).Select(r => r.What).ToList(); }

        public void Clear() { lock (_seen) _seen.Clear(); }
    }

    /// <summary>
    /// Instruments the rig's host: each item, item-list and user-data read made while an attempt runs must be a fact of that
    /// attempt's read-set (the accessor records the value it read, with how to read it again). A query whose result is one
    /// fact reads its parts unrecorded; the fact is the query's.
    /// </summary>
    private static Reads Audit(PrivacyHostShapeModelTests.Rig rig)
    {
        var seen = new Reads();
        rig.Library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) =>
        {
            if (PrivacyReadSet.Current is { } reads) seen.Add(reads, "item " + id, set => set.HoldsLibrary(id));
            return rig.Items.GetValueOrDefault(id)!;
        });
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            if (PrivacyReadSet.Current is { } reads) foreach (var id in q.ItemIds ?? []) seen.Add(reads, "listed item " + id, set => set.HoldsLibrary(id));
            return (q.ItemIds ?? []).Select(id => rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList();
        });
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), It.IsAny<BaseItem>()))
            .Returns((Jellyfin.Database.Implementations.Entities.User user, BaseItem item) =>
            {
                if (PrivacyReadSet.Current is { } reads) seen.Add(reads, "watched " + item.Id, set => set.HoldsWatched(user.Id, item.Id));
                return new UserItemData { Key = "k", Played = rig.Played.Contains((user.Id, item.Id)) };
            });
        return seen;
    }

    [Theory]
    [InlineData("TvShows.GetEpisodes.json", "sg-series")]
    [InlineData("Items.GetItems.json", "hc-movie")]
    [InlineData("ActivityLog.GetLogEntries.json", "sg-series")]
    [InlineData("Search.GetSearchHints.titles.json", "hc-movie")]
    public void EveryHostReadOfAGatedAnswerIsInItsReadSet(string file, string ruleId)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        rig.Commit(Rule(ruleId), viewer);
        var outside = Audit(rig);
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(PrivacyHostShapeModelTests.Value(shot)), new object());
        gate.OnResultExecuting(delivery);
        Assert.IsAssignableFrom<ObjectResult>(delivery.Result);
        var unrecorded = outside.Outside();
        Assert.True(unrecorded.Count == 0, "host reads outside the read-set: " + string.Join(", ", unrecorded.Distinct().Take(20)));
    }

    [Fact]
    public void AHostReadOutsideTheAccessorIsCaught()
    {
        // Control: an attempt that asks the host directly (not through the accessor) is reported, and its input's change
        // goes unseen by the gate: why every verdict input is read through the accessor.
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var outside = Audit(rig);
        var episode = (MediaBrowser.Controller.Entities.TV.Episode)rig.Items[PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles["episode:show-e1"])];
        var planted = PrivacyDelivery.Deliver(rig.Viewer, () =>
        {
            var item = rig.Library.Object.GetItemById(episode.Id);
            episode.SeriesId = Guid.NewGuid();
            rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object, new ItemChangeEventArgs { Item = episode, UpdateReason = ItemUpdateType.MetadataImport });
            return item;
        });
        Assert.NotNull(planted);
        Assert.Contains("item " + episode.Id, outside.Outside());
        outside.Clear();
        // Through the accessor the same read is held, and the change withholds the stale answer.
        var accessed = PrivacyDelivery.Deliver(rig.Viewer, () =>
        {
            var item = PrivacyReads.Item(rig.Library.Object, episode.Id);
            episode.SeriesId = Guid.NewGuid();
            rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object, new ItemChangeEventArgs { Item = episode, UpdateReason = ItemUpdateType.MetadataImport });
            return item;
        });
        Assert.Empty(outside.Outside());
        Assert.Null(accessed);
    }

    [Fact]
    public void AProgressSaveMovesOnlyTheAnswersThatReadThePosition()
    {
        var data = new Mock<IUserDataManager>();
        PrivacyInputs.Observe(null, data.Object);
        var user = new Jellyfin.Database.Implementations.Entities.User("progress", "default", "default") { Id = Guid.NewGuid() };
        var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid() };
        var stored = new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = 10 };
        data.Setup(d => d.GetUserData(user, It.IsAny<BaseItem>())).Returns(() => stored);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([episode]);
        void Save(bool played, long position)
        {
            // The host's store holds the saved data, then announces it.
            stored = new UserItemData { Key = "k", Played = played, PlaybackPositionTicks = position };
            data.Raise(d => d.UserDataSaved += null, data.Object, new UserDataSaveEventArgs
            {
                UserId = user.Id, Item = episode, SaveReason = UserDataSaveReason.PlaybackProgress, UserData = stored,
            });
        }
        PrivacyReadSet watched, progress;
        using (var scope = PrivacyReadSet.Begin()) { PrivacyReads.Item(library.Object, episode.Id); PrivacyReads.UserData(data.Object, user, episode); watched = scope.Reads; }
        using (var scope = PrivacyReadSet.Begin())
        {
            PrivacyReads.Item(library.Object, episode.Id);
            PrivacyReads.UserData(data.Object, user, episode, "position", d => d?.PlaybackPositionTicks.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-");
            progress = scope.Reads;
        }
        Save(false, 20);
        Assert.True(watched.Valid(), "a progress save with the watched state unchanged moved a watched-state verdict");
        Assert.False(progress.Valid(), "a progress save did not move a decision that reads the position");
        Save(true, 30);
        Assert.False(watched.Valid(), "marking the episode watched did not move its verdict");
    }

    [Fact]
    public void EveryGatedAnswersBytesAreGuardedWhereTheyLeave()
    {
        var scan = PrivacyDeliveryScan.Run();
        Assert.True(scan.Unguarded.Count == 0, "gated emitters whose bytes no guard checks:\n" + string.Join("\n", scan.Unguarded));
        Assert.Contains(scan.Writers, w => w.Name.EndsWith("TagCacheResponseBody+SegmentedResult.ExecuteResultAsync", StringComparison.Ordinal) && w.Guarded == "guard");
        var open = scan.Writers.Where(w => w.Guarded == null).Select(w => w.Name).ToList();
        Assert.True(open.Count == 0, "writers of response bytes without the guard:\n" + string.Join("\n", open));
        if (Environment.GetEnvironmentVariable("JE_DELIVERY_SCAN_OUT") is { Length: > 0 } path)
            File.AppendAllLines(path, scan.Writers.Select(w => "writer\t" + w.Name + "\t" + (w.Guarded ?? "NONE")));
    }

    /// <summary>A deferred result that writes its bytes without the guard (the shape of D46-R23-7).</summary>
    private sealed class PlantedWriter : IActionResult
    {
        public Task ExecuteResultAsync(ActionContext context) => context.HttpContext.Response.Body.WriteAsync(new byte[] { 1 }).AsTask();
    }

    [Fact]
    public void TheScanFindsAWriterThatSendsWithoutTheGuard()
    {
        var scan = PrivacyDeliveryScan.Run([], typeof(PlantedWriter).Assembly);
        Assert.Contains(scan.Writers, w => w.Name.EndsWith("PlantedWriter.ExecuteResultAsync", StringComparison.Ordinal) && w.Guarded == null);
    }

    [Fact]
    public async Task AValidatorIsConfirmedOnlyWhileItsReadSetHolds()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var http = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        PrivacyReadSet reads;
        using (var scope = PrivacyReadSet.Begin()) { rig.F.Core.Manager.GetUserConfiguration<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur>(rig.Viewer.ToString("N"), "spoilerblur.json"); reads = scope.Reads; }
        PrivacyResponseGuard.Install(http, reads);
        var confirm = PrivacyResponseGuard.Confirm(http, new StatusCodeResult(304));
        rig.Commit(Rule("sg-series"), rig.Viewer);
        await confirm.ExecuteResultAsync(new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), new Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor()));
        Assert.Equal(503, http.Response.StatusCode);
    }
}
