using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Playlists;
using Moq;

namespace JE.Tests;

/// <summary>
/// 4f review round 2. Security-1: Jellyfin derives a playlist's id from its folder, so a person who deletes the managed
/// playlist while Ready updates are off and later makes one under the same (marker) folder name gets the same id. Only a
/// playlist carrying the random nonce JE wrote into it at creation, with the creation time JE recorded, is ever JE's: a
/// replacement is never written, renamed or deleted (the binding is lost; turning Ready on again makes a new playlist), a
/// restored binding is refused the same way, and an interrupted create is only recovered once it carries the nonce.
/// Security-2: the membership write checks every desired version's Hidden Content and access again right before Jellyfin
/// is called; a change there stops the write and the pass chooses again.
/// </summary>
public class ReadyIdentityTests
{
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Tears = TitleKey.Parse("movie:tmdb:133701")!;
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

    // Calls Jellyfin was allowed to make on a playlist since a point in the log.
    private static IEnumerable<string> Allowed(ReadyWorld w, int since) => w.Host.Gates.Skip(since).Where(g => g.Refused == null).Select(g => g.Call);

    // ------------------------------------------------------------------ security-1: a same-id replacement

    [Theory]
    [InlineData("switch", false, 3)]
    [InlineData("switch", true, 3)]
    [InlineData("switch", true, 120)]
    [InlineData("opt_out", false, 120)]
    [InlineData("opt_out", true, 3)]
    [InlineData("opt_out", true, 120)]
    public async Task APlaylistThePersonRemadeWithTheSameIdWhileUpdatesWereOffIsNeverJes(string off, bool withEntries, int minutesLater)
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            Assert.Equal(ReadyPlaylistService.PlaylistName, playlist.Name);
            if (off == "switch") w.Config.ArrPhase4ReadyPlaylistEnabled = false;
            else await w.Service.SetPlaylistAsync(emma.UserId, false);

            // While nothing is updated the person deletes it and, later, makes their own under the folder's (marker) name.
            w.Host.Playlists.Remove(playlist.Id);
            w.Now = w.Now.AddMinutes(minutesLater);
            var theirs = Guid.NewGuid();
            var own = withEntries ? w.Host.AddOwn(emma.UserId, playlist.Folder, theirs) : w.Host.AddOwn(emma.UserId, playlist.Folder);
            Assert.Equal(playlist.Id, own.Id);

            if (off == "switch") w.Config.ArrPhase4ReadyPlaylistEnabled = true;
            else await w.Service.SetPlaylistAsync(emma.UserId, true);
            var since = w.Host.Gates.Count;
            Assert.Equal("lost", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));

            // Never written, renamed or deleted; the binding records it as lost.
            Assert.Empty(Allowed(w, since));
            Assert.Equal(playlist.Folder, own.Name);
            Assert.Equal(withEntries ? new[] { theirs } : Array.Empty<Guid>(), own.Entries);
            var binding = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
            Assert.Equal(ReadyState.Lost, binding.State);
            Assert.Null(binding.PlaylistId);
            Assert.False(binding.OptedIn);
            Assert.Equal(ReadyState.Lost, w.Service.Status(emma.UserId).State);
            Assert.False(w.Service.Status(emma.UserId).CanRemove);
            Assert.Equal("nothing", await w.Service.RemoveAsync(emma.UserId));
            Assert.True(w.Host.Playlists.ContainsKey(own.Id));

            // Turning Ready on again makes a fresh playlist of JE's; theirs stays as it is.
            await w.Service.SetPlaylistAsync(emma.UserId, true);
            Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
            var fresh = w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId!.Value;
            Assert.NotEqual(own.Id, fresh);
            Assert.Equal(new[] { version }, w.Host.Playlists[fresh].Entries);
            Assert.Equal(withEntries ? new[] { theirs } : Array.Empty<Guid>(), own.Entries);
            Assert.Equal(playlist.Folder, own.Name);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RemoveNeverDeletesASameIdReplacement(bool withEntries)
    {
        var (w, emma, playlist, _) = await Ready();
        using (w)
        {
            await w.Service.SetPlaylistAsync(emma.UserId, false);
            w.Host.Playlists.Remove(playlist.Id);
            w.Now = w.Now.AddHours(2);
            var theirs = Guid.NewGuid();
            var own = withEntries ? w.Host.AddOwn(emma.UserId, playlist.Folder, theirs) : w.Host.AddOwn(emma.UserId, playlist.Folder);
            Assert.Equal(playlist.Id, own.Id);
            // Still bound (nothing looked at it while off): Remove sees it isn't JE's and leaves it alone.
            Assert.False(w.Service.Status(emma.UserId).CanRemove);
            Assert.Equal("not_ours", await w.Service.RemoveAsync(emma.UserId));
            Assert.True(w.Host.Playlists.ContainsKey(own.Id));
            Assert.Equal(withEntries ? new[] { theirs } : Array.Empty<Guid>(), own.Entries);
            Assert.DoesNotContain(w.Host.Gates, g => g.Call == "delete" && g.Refused == null);
        }
    }

    [Fact]
    public async Task ARestoredBindingToASameIdReplacementIsRefusedTheSameWay()
    {
        var (w, emma, playlist, _) = await Ready();
        using (w)
        {
            var backup = w.Db.Snapshot()!;
            // After the backup the person deletes the playlist and makes their own under its folder name two hours later.
            w.Host.Playlists.Remove(playlist.Id);
            w.Now = w.Now.AddHours(2);
            var theirs = Guid.NewGuid();
            var own = w.Host.AddOwn(emma.UserId, playlist.Folder, theirs);
            Assert.Equal(playlist.Id, own.Id);

            w.Db.ReplaceWith(backup);
            Assert.Equal(ReadyState.Renew, w.Service.Status(emma.UserId).State);
            await w.Service.SetPlaylistAsync(emma.UserId, true);
            var since = w.Host.Gates.Count;
            Assert.Equal("lost", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Empty(Allowed(w, since));
            Assert.Equal(new[] { theirs }, own.Entries);
            Assert.Equal(playlist.Folder, own.Name);
            Assert.Equal(ReadyState.Lost, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.State);
        }
    }

    [Fact]
    public async Task JesOwnPlaylistCarriesItsNonceAndKeepsWorking()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var binding = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
            Assert.False(string.IsNullOrEmpty(playlist.Nonce));
            Assert.Equal(binding.Nonce, playlist.Nonce);
            Assert.Equal(playlist.Created.ToUnixTimeMilliseconds(), binding.PlaylistCreated);
            // The nonce came with the create itself (4f round 6): no write of it afterwards.
            Assert.Equal(1, w.Host.Creates);
            Assert.DoesNotContain("stamp", w.Host.Calls);

            // A native rename, a restart and an hour later: still JE's, still updated.
            playlist.Name = "Emma's picks";
            w.Now = w.Now.AddHours(1);
            w.Reopen();
            var (_, tears) = w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(new[] { tears[0], version }, playlist.Entries);
            Assert.Equal("Emma's picks", playlist.Name);
            Assert.True(w.Service.Status(emma.UserId).CanRemove);
            Assert.Equal("removed", await w.Service.RemoveAsync(emma.UserId));
            Assert.False(w.Host.Playlists.ContainsKey(playlist.Id));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APlaylistWhoseNonceOrCreationTimeDiffersIsNotJes(bool nonce)
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            // Same id, owner and folder; only the nonce, or only the creation time, differs.
            w.Host.Playlists.Remove(playlist.Id);
            var copy = new FakeReadyPlaylistHost.Native
            {
                Id = playlist.Id, Owner = playlist.Owner, Folder = playlist.Folder, Name = playlist.Name,
                Created = nonce ? playlist.Created : playlist.Created.AddMinutes(5), Nonce = nonce ? Guid.NewGuid().ToString("N") : playlist.Nonce,
            };
            copy.Entries.Add(version);
            w.Host.Playlists[copy.Id] = copy;
            var (_, tears) = w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            var since = w.Host.Gates.Count;
            Assert.Equal("lost", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Empty(Allowed(w, since));
            Assert.Equal(new[] { version }, copy.Entries);
            _ = tears;
        }
    }

    // ------------------------------------------------------------------ security-1: interrupted creates (r1's residual)

    [Fact]
    public async Task APlaylistWithoutJesNonceIsNeverAdoptedEvenEmptyWithinTheMinute()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // JE stops right after Jellyfin's create returned, before it recorded the second the create showed: that create isn't
        // recovered (a new one is made), whatever its playlist carries.
        w.Host.FailAfter = "create";
        Assert.Equal("native_error", await w.Service.ReconcileAsync(emma.UserId));
        var made = Assert.Single(w.Host.Playlists.Values);
        Assert.Null(w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistCreated);

        // The person deletes it and, within the same minute, makes an empty one under the visible marker name: same id.
        w.Host.Playlists.Remove(made.Id);
        w.Now = w.Now.AddSeconds(20);
        var own = w.Host.AddOwn(emma.UserId, made.Name);
        Assert.Equal(made.Id, own.Id);

        w.Reopen();
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.NotEqual(own.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.Equal(made.Name, own.Name);
        Assert.Empty(own.Entries);
        Assert.Null(own.Nonce);
        Assert.DoesNotContain(w.Host.Sets, s => s.Playlist == own.Id);
    }

    [Fact]
    public async Task AnInterruptedCreateCarryingJesNonceIsRecovered()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // JE stops after the create (its nonce in the playlist, its second recorded), before the playlist was bound.
        w.Host.FailGet = true;
        Assert.Equal("native_error", await w.Service.ReconcileAsync(emma.UserId));
        var made = Assert.Single(w.Host.Playlists.Values);
        Assert.NotNull(made.Nonce);

        w.Now = w.Now.AddHours(1);
        w.Reopen();
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(1, w.Host.Creates);
        Assert.Equal(made.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.Equal(ReadyPlaylistService.PlaylistName, made.Name);
        Assert.Equal(new[] { versions[0] }, made.Entries);
    }

    // ------------------------------------------------------------------ security-1: the production host

    private const string Folder = "/config/data/playlists/Ready to watch (0123456789abcdef0123456789abcdef)";

    private static Playlist Make(Guid id, Guid owner, string? nonce, DateTime created)
    {
        var p = new Playlist { Id = id, Name = ReadyPlaylistService.PlaylistName, OwnerUserId = owner, Path = Folder, Shares = Array.Empty<PlaylistUserPermissions>(), DateCreated = created };
        if (nonce != null) p.ExternalId = JellyfinReadyPlaylistHost.NoncePrefix + nonce;
        return p;
    }

    [Fact]
    public void TheProductionHostReadsJesNonceFromTheStoredPlaylist()
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var created = new DateTime(2026, 10, 18, 9, 0, 0, DateTimeKind.Utc);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.RetrieveItem(id)).Returns(Make(id, owner, "n0nce", created));
        var host = new JellyfinReadyPlaylistHost(library.Object, Mock.Of<IPlaylistManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        var info = host.Get(id)!;
        Assert.Equal("n0nce", info.Nonce);
        Assert.Equal(created, info.Created.UtcDateTime);
    }

    [Fact]
    public void TheNonceLivesInAColumnJellyfinsOwnPlaylistSavesKeepNotInProviderIds()
    {
        // Seen live on 12.2: Jellyfin's UpdatePlaylist (rename, share, membership) saves an instance read without provider
        // ids, which deletes them. The nonce is the item's ExternalId, which every read maps.
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var created = new DateTime(2026, 10, 18, 9, 0, 0, DateTimeKind.Utc);
        var afterNativeSave = Make(id, owner, "n0nce", created);
        afterNativeSave.ProviderIds = new Dictionary<string, string>();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.RetrieveItem(id)).Returns(afterNativeSave);
        var host = new JellyfinReadyPlaylistHost(library.Object, Mock.Of<IPlaylistManager>(), Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        Assert.Equal("n0nce", host.Get(id)!.Nonce);
        // A value someone could put in a provider id is not JE's nonce, nor is an ExternalId without JE's prefix.
        var other = Make(id, owner, null, created);
        other.ProviderIds["JellyfinEnhancedReady"] = "n0nce";
        other.ExternalId = "n0nce";
        library.Setup(l => l.RetrieveItem(id)).Returns(other);
        Assert.Null(host.Get(id)!.Nonce);
    }

    [Fact]
    public async Task TheProductionHostReadsThePlaylistAgainAfterTheHealAndWritesNothingWhenItIsAnotherOne()
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var created = new DateTime(2026, 10, 18, 9, 0, 0, DateTimeKind.Utc);
        var library = new Mock<ILibraryManager>();
        // The gate passes on JE's playlist; by the time the cached instance is healed Jellyfin stores another one with the
        // same id (deleted and made again in between).
        library.SetupSequence(l => l.RetrieveItem(id)).Returns(Make(id, owner, "n0nce", created)).Returns(Make(id, owner, null, created.AddHours(2)));
        library.Setup(l => l.GetItemById(id)).Returns(Make(id, owner, null, created.AddHours(2)));
        var playlists = new Mock<IPlaylistManager>();
        var host = new JellyfinReadyPlaylistHost(library.Object, playlists.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        // The gate lets it through (it saw JE's playlist); the re-read after the heal must stop the write.
        Assert.Equal("identity", await host.SetAsync(id, new[] { Guid.NewGuid() }, owner, _ => null));
        playlists.Verify(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()), Times.Never);
        library.Verify(l => l.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>(), It.IsAny<bool>()), Times.Never);
    }

    // ------------------------------------------------------------------ security-2: the final membership check

    [Theory]
    [InlineData("hide_item")]
    [InlineData("hide_version")]
    [InlineData("hide_title")]
    [InlineData("revoke")]
    public async Task AHideOrRevokeRightBeforeTheMembershipWriteNeverInsertsTheVersion(string change)
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var (tearsItem, tears) = w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            var done = false;
            w.Host.During = call =>
            {
                if (call != "set" || done) return;
                done = true;
                switch (change)
                {
                    case "hide_item": w.Privacy.Rules[emma.UserId] = new ReadyHides(new[] { tearsItem }, Array.Empty<Guid>(), Array.Empty<string>()); break;
                    case "hide_version": w.Privacy.Rules[emma.UserId] = new ReadyHides(new[] { tears[0] }, Array.Empty<Guid>(), Array.Empty<string>()); break;
                    case "hide_title": w.Privacy.Rules[emma.UserId] = new ReadyHides(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { "movie:tmdb:133701" }); break;
                    default: w.Library.OpenTo[tears[0]] = new HashSet<Guid>(); break;
                }
            };
            var sets = w.Host.Sets.Count;
            var result = await w.Service.ReconcileAsync(emma.UserId);
            Assert.True(done);
            Assert.Contains(w.Host.Gates, g => g.Call == "set" && g.Refused == "stale");
            // Never inserted, and the pass chose again: the playlist holds what is right now.
            Assert.DoesNotContain(w.Host.Sets.Skip(sets), s => s.Items.Contains(tears[0]));
            Assert.Equal(new[] { version }, playlist.Entries);
            Assert.Equal("unchanged", result);
            Assert.Equal(new[] { version }, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.Confirmed);
        }
    }

    [Fact]
    public async Task HiddenContentThatCantBeReadRightBeforeTheWriteStopsIt()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var (_, tears) = w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            w.Host.During = call =>
            {
                if (call == "set") w.Privacy.Rules[emma.UserId] = null;
            };
            var sets = w.Host.Sets.Count;
            Assert.NotEqual("updated", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(sets, w.Host.Sets.Count);
            Assert.Equal(new[] { version }, playlist.Entries);
            _ = tears;
        }
    }

    [Fact]
    public async Task ChangesThatKeepComingEndThePassAfterAFewTriesAndQueueAnotherLook()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            var (_, tears) = w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            // Every selection sees the version visible and every final check sees it hidden (a hide/unhide in a loop).
            var loads = 0;
            var hidden = new ReadyHides(new[] { tears[0] }, Array.Empty<Guid>(), Array.Empty<string>());
            w.Privacy.OnLoad = _ => w.Privacy.Rules[emma.UserId] = ++loads % 2 == 0 ? hidden : ReadyHides.None;
            var gates = w.Host.Gates.Count;
            var sets = w.Host.Sets.Count;
            var queued = w.Service.QueuedCount;
            Assert.Equal("changed", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(ReadyPlaylistService.MaxChoices, w.Host.Gates.Skip(gates).Count(g => g.Call == "set" && g.Refused == "stale"));
            Assert.Equal(sets, w.Host.Sets.Count);
            Assert.Equal(new[] { version }, playlist.Entries);
            Assert.Equal(queued + 1, w.Service.QueuedCount);
        }
    }
}
