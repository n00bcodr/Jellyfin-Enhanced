using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;

namespace JE.Tests;

/// <summary>
/// The Ready playlist's lifecycle against Jellyfin's playlists in memory: one private playlist per person made under its own
/// marker and never found by name; add → watch → remove; access, Hidden Content and upgrades; a crash before or after each
/// native change and a restart; a deletion confirmed by two reads a minute apart and respected until the person turns it on
/// again; disable keeps the playlist and Remove deletes only it; a shared or public playlist stops getting writes; restored
/// and foreign bindings revalidated; deleted people; the switches; and no native call inside a database write.
/// </summary>
public class ReadyPlaylistServiceTests
{
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Tears = TitleKey.Parse("movie:tmdb:133701")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;
    private static readonly DateTime Arrived = ReadyWorld.Since.AddDays(2);

    private static async Task<(ReadyWorld W, StatusViewer Emma, FakeReadyPlaylistHost.Native Playlist, Guid Version)> Ready()
    {
        var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        var playlist = Assert.Single(w.Host.Playlists.Values);
        return (w, emma, playlist, versions[0]);
    }

    [Fact]
    public async Task TurningItOnMakesOnePrivatePlaylistUnderItsOwnMarkerAndNamesIt()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var binding = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
            Assert.Equal(playlist.Id, binding.PlaylistId);
            Assert.NotNull(binding.Marker);
            Assert.Contains(binding.Marker!, playlist.Folder, StringComparison.Ordinal);
            Assert.Equal(ReadyPlaylistService.PlaylistName, playlist.Name);
            Assert.Equal(emma.UserId, playlist.Owner);
            Assert.False(playlist.Public);
            Assert.Equal(0, playlist.Shares);
            Assert.Equal(new[] { version }, playlist.Entries);
            Assert.Equal(new[] { version }, binding.Confirmed);
            Assert.Null(binding.PendingOperation);
            Assert.Equal("unchanged", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(1, w.Host.Creates);
        }
    }

    [Fact]
    public async Task APlaylistOfTheSameNameThePersonMadeIsNeverAdoptedOrTouched()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var other = Guid.NewGuid();
        var own = w.Host.AddOwn(emma.UserId, ReadyPlaylistService.PlaylistName, other);
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.Equal(2, w.Host.Playlists.Count);
        Assert.Equal(new[] { other }, own.Entries);
        Assert.Equal(ReadyPlaylistService.PlaylistName, own.Name);
        Assert.NotEqual(own.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);

        // Even after a crash between the create (its nonce written) and its record, recovery goes by the recorded id and JE's
        // nonce, never by name.
        using var x = new ReadyWorld();
        var sam = x.User();
        var samOwn = x.Host.AddOwn(sam.UserId, ReadyPlaylistService.PlaylistName);
        x.Movie(Tears, Arrived);
        x.Interests.Add(sam.UserId, "w:1", ReadyInterestKind.Request, Tears);
        await x.Service.SetPlaylistAsync(sam.UserId, true);
        x.Host.FailGet = true;
        Assert.Equal("native_error", await x.Service.ReconcileAsync(sam.UserId));
        x.Reopen();
        Assert.Equal("updated", await x.Service.ReconcileAsync(sam.UserId));
        Assert.Equal(1, x.Host.Creates);
        Assert.Equal(2, x.Host.Playlists.Count);
        Assert.Empty(samOwn.Entries);
        Assert.NotEqual(samOwn.Id, x.Store.Binding(ReadyWorld.Server, sam.UserId)!.PlaylistId);
        _ = versions;
    }

    [Fact]
    public async Task AddedThenWatchedThenGone()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var item = w.View.Items.Values.Single(i => i.Ref.Kind == "movie").Ref.ItemId;
            // A second title arrives later: newest first.
            var (_, tears) = w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(new[] { tears[0], version }, playlist.Entries);

            w.Library.Watched.Add((emma.UserId, item));
            Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { tears[0] }, playlist.Entries);
            Assert.Contains("set", w.Host.Calls);
            // Marking it unplayed doesn't bring it back.
            w.Library.Watched.Clear();
            Assert.Equal("unchanged", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { tears[0] }, playlist.Entries);
        }
    }

    [Fact]
    public async Task LostAccessHiddenContentAndARemovedInterestEachTakeTheEntryOut()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            w.Library.OpenTo[version] = new HashSet<Guid>();
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Empty(playlist.Entries);
            w.Library.OpenTo.Clear();
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(new[] { version }, playlist.Entries);

            w.Privacy.Rules[emma.UserId] = new ReadyHides(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { "movie:tmdb:45745" });
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Empty(playlist.Entries);
            // Rules that can't be read change nothing (no add, no removal) until they can.
            w.Privacy.Rules[emma.UserId] = null;
            var calls = w.Host.Calls.Count;
            Assert.Equal("unreadable", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(calls, w.Host.Calls.Count);
            w.Privacy.Rules.Remove(emma.UserId);
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(new[] { version }, playlist.Entries);

            // Interests that can't be read change nothing either; a cancelled request takes it out.
            w.Interests.Of[emma.UserId] = null;
            Assert.Equal("unreadable", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { version }, playlist.Entries);
            w.Interests.Of[emma.UserId] = new List<ReadyInterest>();
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Empty(playlist.Entries);
            Assert.Empty(w.Store.Entries(ReadyWorld.Server, emma.UserId));
        }
    }

    [Fact]
    public async Task AnUpgradeReplacesTheEntryWithoutADuplicate()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var item = w.View.Items.Values.Single(i => i.Ref.Kind == "movie").Ref.ItemId;
            w.View.SourcesByItem[item].Clear();
            var uhd = Guid.NewGuid();
            w.View.SourcesByItem[item].Add(new JfSource { SourceId = uhd, ItemId = item, BackingItemId = uhd, Width = 3840, Height = 2160, DateCreated = Arrived.AddDays(5) });
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(new[] { uhd }, playlist.Entries);
            Assert.DoesNotContain(version, playlist.Entries);
        }
    }

    [Theory]
    [InlineData("set", false, false)]
    [InlineData("set", true, false)]
    [InlineData("set-cleared", true, false)]
    [InlineData("set", false, true)]
    [InlineData("set", true, true)]
    [InlineData("set-cleared", true, true)]
    public async Task ACrashBeforeDuringOrAfterTheChangeSettlesFromWhatJellyfinHasAfterARestart(string fault, bool after, bool watched)
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var item = w.View.Items.Values.Single(i => i.Ref.Kind == "movie").Ref.ItemId;
            var (_, tears) = w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            if (watched) w.Library.Watched.Add((emma.UserId, item));
            if (after) w.Host.FailAfter = fault;
            else w.Host.FailBefore = fault;
            Assert.Equal("native_error", await w.Service.ReconcileAsync(emma.UserId));
            // The change was journalled and is still open.
            Assert.NotNull(w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PendingOperation);

            w.Reopen();
            Assert.Contains(await w.Service.ReconcileAsync(emma.UserId), new[] { "updated", "unchanged" });
            var expected = watched ? new[] { tears[0] } : new[] { tears[0], version };
            Assert.Equal(expected, playlist.Entries);
            var binding = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
            Assert.Null(binding.PendingOperation);
            Assert.Equal(expected, binding.Confirmed);
            Assert.Equal("unchanged", await w.Service.ReconcileAsync(emma.UserId));
        }
    }

    // Found live on 10.11: Jellyfin reads the playlist file again after each change and then keeps entries by path; the raw
    // read counted only entries with an item id, saw an empty playlist and added everything again (duplicates). Now the
    // whole membership is set in one change, so duplicates and entries that resolve to nothing go, and nothing is added twice.
    [Fact]
    public async Task DuplicateAndDanglingEntriesAreRewrittenToExactlyTheDesiredOnes()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            playlist.Entries.Clear();
            playlist.Entries.AddRange(new[] { version, Guid.Empty, version });
            Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { version }, playlist.Entries);
            Assert.Equal("unchanged", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { version }, playlist.Entries);
        }
    }

    [Fact]
    public void AnEntryJellyfinKeepsByPathOnlyCountsAsTheItemItsPathResolvesTo()
    {
        var item = Guid.NewGuid();
        var other = Guid.NewGuid();
        // A path-only entry is how 10.11 keeps playlist entries after reading the file again (12.x marks Path obsolete).
#pragma warning disable CS0618
        var byPath = new MediaBrowser.Controller.Entities.LinkedChild { Path = "/readymedia/movies/a.mkv" };
        var gone = new MediaBrowser.Controller.Entities.LinkedChild { Path = "/readymedia/movies/gone.mkv" };
#pragma warning restore CS0618
        var byId = new MediaBrowser.Controller.Entities.LinkedChild { ItemId = other };
        var raw = JellyfinReadyPlaylistHost.RawIds(new[] { byPath, byId, gone, byPath }, new[] { (byPath, item), (byId, other) });
        Assert.Equal(new[] { item, other, Guid.Empty, item }, raw);
    }

    [Fact]
    public async Task AnAddJellyfinIgnoresIsNotConfirmed()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Host.Refuses.Add(versions[0]);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.Empty(w.Store.Binding(ReadyWorld.Server, emma.UserId)!.Confirmed);
        Assert.Empty(w.Host.Playlists.Values.Single().Entries);
        // Not asked for again on every pass; after a while it is.
        var sets = w.Host.Calls.Count(c => c == "set");
        Assert.Equal("unchanged", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(sets, w.Host.Calls.Count(c => c == "set"));
        w.Now = w.Now + ReadyPlaylistService.RefusedFor + TimeSpan.FromMinutes(1);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(sets + 1, w.Host.Calls.Count(c => c == "set"));
    }

    [Fact]
    public async Task ADeletionIsConfirmedByTwoReadsAMinuteApartAndRespectedUntilRenewal()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            w.Host.Playlists.Remove(playlist.Id);
            w.Service.OnItemRemoved(playlist.Id, isPlaylist: true);
            await w.Service.RunPendingAsync();
            Assert.Equal(ReadyState.Active, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.State);
            w.Now = w.Now.AddSeconds(20);
            Assert.Equal("missing", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(ReadyState.Active, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.State);
            w.Now = w.Now.AddMinutes(2);
            Assert.Equal("deleted", await w.Service.ReconcileAsync(emma.UserId));
            var binding = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
            Assert.Equal(ReadyState.Deleted, binding.State);
            Assert.False(binding.OptedIn);
            Assert.Null(binding.PlaylistId);

            // Not made again on its own, after a restart either.
            w.Reopen();
            Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(1, w.Host.Creates);
            Assert.Equal(ReadyState.Deleted, w.Service.Status(emma.UserId).State);

            // Turned on again: a new playlist with the entries.
            await w.Service.SetPlaylistAsync(emma.UserId, true);
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(2, w.Host.Creates);
            Assert.Equal(new[] { version }, w.Host.Playlists.Values.Single().Entries);
        }
    }

    [Fact]
    public async Task APlaylistDeletedWhileAnAddWaitsIsNeitherRecreatedNorFatal()
    {
        var (w, emma, playlist, _) = await Ready();
        using (w)
        {
            w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            w.Host.During = call =>
            {
                if (call == "set") w.Host.Playlists.Remove(playlist.Id);
            };
            // Gone right before the change: no write, and a first missing read.
            Assert.Equal("missing", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(1, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.MissingCount);
            w.Host.During = null;
            Assert.Equal("missing", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(1, w.Host.Creates);
        }
    }

    [Fact]
    public async Task TurningItOffKeepsThePlaylistAndRemoveDeletesOnlyIt()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var own = w.Host.AddOwn(emma.UserId, "Road trip", Guid.NewGuid());
            await w.Service.SetPlaylistAsync(emma.UserId, false);
            var item = w.View.Items.Values.Single(i => i.Ref.Kind == "movie").Ref.ItemId;
            w.Library.Watched.Add((emma.UserId, item));
            var calls = w.Host.Calls.Count;
            Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(calls, w.Host.Calls.Count);
            Assert.Equal(new[] { version }, playlist.Entries);
            Assert.True(w.Service.Status(emma.UserId).CanRemove);

            Assert.Equal("removed", await w.Service.RemoveAsync(emma.UserId));
            Assert.False(w.Host.Playlists.ContainsKey(playlist.Id));
            Assert.True(w.Host.Playlists.ContainsKey(own.Id));
            Assert.Equal(ReadyState.Removed, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.State);
            Assert.Equal("nothing", await w.Service.RemoveAsync(emma.UserId));

            // Turned on again: a new one.
            w.Library.Watched.Clear();
            await w.Service.SetPlaylistAsync(emma.UserId, true);
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(2, w.Host.Creates);
        }
    }

    [Theory]
    [InlineData("shared")]
    [InlineData("public")]
    [InlineData("owner")]
    public async Task ASharedPublicOrTransferredPlaylistGetsNoMoreWrites(string change)
    {
        var (w, emma, playlist, _) = await Ready();
        using (w)
        {
            switch (change)
            {
                case "shared": playlist.Shares = 1; break;
                case "public": playlist.Public = true; break;
                default: playlist.Owner = Guid.NewGuid(); break;
            }

            w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            var calls = w.Host.Calls.Count;
            Assert.Equal("privacy", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(calls, w.Host.Calls.Count);
            Assert.Equal(ReadyState.Privacy, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.State);
            Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(calls, w.Host.Calls.Count);

            // Remove deletes it only while it is still the person's own and private (4f-r1-security-3): shared or public, it is
            // kept as it is; another owner's is left alone. Either way JE stops managing it.
            Assert.Equal(change == "owner" ? "not_ours" : "kept", await w.Service.RemoveAsync(emma.UserId));
            Assert.True(w.Host.Playlists.ContainsKey(playlist.Id));
            Assert.DoesNotContain("delete", w.Host.Gates.Where(g => g.Refused == null).Select(g => g.Call));
        }
    }

    [Fact]
    public async Task ARestoredBindingIsRevalidatedInFullOnRenewalAndNeverMutatedBefore()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            w.Db.ReplaceWith(w.Db.Snapshot()!);
            Assert.Equal(ReadyState.Renew, w.Service.Status(emma.UserId).State);
            var item = w.View.Items.Values.Single(i => i.Ref.Kind == "movie").Ref.ItemId;
            w.Library.Watched.Add((emma.UserId, item));
            var calls = w.Host.Calls.Count;
            Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(calls, w.Host.Calls.Count);
            Assert.Equal(new[] { version }, playlist.Entries);

            // Renewed: the same playlist, checked (owner, privacy, marker) before it is changed.
            await w.Service.SetPlaylistAsync(emma.UserId, true);
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(1, w.Host.Creates);
            Assert.Empty(playlist.Entries);
        }

        // A restored id that now names a playlist without the marker (another installation's, or reused) is never touched.
        var (x, sam, samPlaylist, _) = await Ready();
        using (x)
        {
            x.Db.ReplaceWith(x.Db.Snapshot()!);
            var stranger = x.Host.AddOwn(sam.UserId, "Kids", Guid.NewGuid());
            x.Host.Playlists.Remove(samPlaylist.Id);
            x.Host.Playlists.Remove(stranger.Id);
            var swapped = new FakeReadyPlaylistHost.Native { Id = samPlaylist.Id, Owner = sam.UserId, Folder = "Kids", Name = "Kids" };
            swapped.Entries.AddRange(stranger.Entries);
            x.Host.Playlists[swapped.Id] = swapped;
            await x.Service.SetPlaylistAsync(sam.UserId, true);
            // Not JE's (no marker, no nonce): lost, never touched; the binding is dropped, so Remove has nothing to delete.
            Assert.Equal("lost", await x.Service.ReconcileAsync(sam.UserId));
            Assert.Equal(stranger.Entries, swapped.Entries);
            Assert.Equal("Kids", swapped.Name);
            Assert.Equal((ReadyState.Lost, "identity"), (x.Store.Binding(ReadyWorld.Server, sam.UserId)!.State, x.Store.Binding(ReadyWorld.Server, sam.UserId)!.Reason));
            Assert.Equal("nothing", await x.Service.RemoveAsync(sam.UserId));
            Assert.True(x.Host.Playlists.ContainsKey(swapped.Id));
        }
    }

    [Fact]
    public async Task AnotherServersBindingIsInvisibleAndNeverMutated()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            w.Reopen(server: "server-b");
            Assert.Equal(ReadyState.Off, w.Service.Status(emma.UserId).State);
            Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { version }, playlist.Entries);
            Assert.Equal(1, w.Host.Creates);
        }
    }

    [Fact]
    public async Task ADeletedOrDisabledPersonGetsNoWork()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            w.View.Users.Remove(emma.UserId);
            w.Library.Watched.Add((emma.UserId, w.View.Items.Values.Single(i => i.Ref.Kind == "movie").Ref.ItemId));
            Assert.Equal("no_user", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { version }, playlist.Entries);
        }
    }

    [Fact]
    public async Task WithTheSwitchOffNothingHappensAndTheOptInIsRefused()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        w.Config.ArrPhase4ReadyPlaylistEnabled = false;
        var status = await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.False(status.Enabled);
        Assert.False(status.OptedIn);
        Assert.Equal("off", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Empty(w.Host.Calls);
        // Each parent switch counts (phase 3 too); notifications don't matter.
        w.Config.ArrPhase4ReadyPlaylistEnabled = true;
        w.Config.ArrPhase3Enabled = false;
        Assert.False(ReadyFlags.Playlist(w.Config));
        w.Config.ArrPhase3Enabled = true;
        w.Config.ArrNotificationsEnabled = false;
        w.Config.ArrPhase2Enabled = false;
        Assert.True(ReadyFlags.Playlist(w.Config));
        // Off for each person until they turn it on.
        Assert.False(w.Service.Status(emma.UserId).OptedIn);
        Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
    }

    [Fact]
    public async Task NoNativeCallIsMadeInsideADatabaseWrite()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        var checkedCalls = 0;
        // Each native call takes the database writer from another thread: a call made inside a write would wait forever.
        w.Host.During = _ =>
        {
            Assert.True(Task.Run(() => w.Db.Write((c, t) => 0)).Wait(TimeSpan.FromSeconds(10)), "a native call ran inside a database write");
            checkedCalls++;
        };
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        await w.Service.ReconcileAsync(emma.UserId);
        w.Library.Watched.Add((emma.UserId, w.View.Items.Values.Single(i => i.Ref.Kind == "movie").Ref.ItemId));
        await w.Service.ReconcileAsync(emma.UserId);
        await w.Service.RemoveAsync(emma.UserId);
        Assert.True(checkedCalls >= 4);
    }

    [Fact]
    public async Task EventsOnlyQueueBoundedWorkAndArrivalsReachThePeopleInterested()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var sam = w.User();
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        w.Interests.Add(sam.UserId, "w:2", ReadyInterestKind.Request, Tears);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        await w.Service.SetPlaylistAsync(sam.UserId, true);
        await w.Service.RunPendingAsync();
        var (_, versions) = w.Movie(Sintel, Arrived);
        for (var i = 0; i < 5000; i++) w.Service.OnArrival(new[] { Sintel });
        Assert.True(w.Service.QueuedCount <= ReadyPlaylistService.QueueCapacity);
        await w.Service.RunPendingAsync();
        var emmaList = w.Host.Playlists.Values.Single(p => p.Owner == emma.UserId);
        Assert.Equal(versions, emmaList.Entries);
        Assert.Empty(w.Host.Playlists.Values.Single(p => p.Owner == sam.UserId).Entries);
    }

    [Fact]
    public async Task ASeasonGoesInInEpisodeOrderAndALaterEpisodeTakesItsPlace()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var series = w.Series(Firefly, Arrived);
        var e2 = w.View.AddEpisodeFile(series, Firefly, 1, 2, 1920, 1080, Arrived);
        var e3 = w.View.AddEpisodeFile(series, Firefly, 1, 3, 1920, 1080, Arrived);
        w.Interests.Add(emma.UserId, "w:s1", ReadyInterestKind.Request, Firefly, whole: false, seasons: new[] { 1 });
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        await w.Service.ReconcileAsync(emma.UserId);
        var playlist = w.Host.Playlists.Values.Single();
        Assert.Equal(new[] { e2, e3 }, playlist.Entries);
        var e1 = w.View.AddEpisodeFile(series, Firefly, 1, 1, 1920, 1080, Arrived.AddHours(1));
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.Equal(new[] { e1, e2, e3 }, playlist.Entries);
        Assert.Contains("set", w.Host.Calls);
    }
}
