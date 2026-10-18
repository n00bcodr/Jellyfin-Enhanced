using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 2 (4c1-r2-security-1, 4c1-B4-r2): a retried create recognises the list its first attempt made only by a
// marker Jellyfin keeps in the same write that creates the list (since round 3: the folder Jellyfin makes from the name
// the create runs under, and a provider id on a collection), never by its name or creation time. A namesake, someone
// else's or the caller's own, is never adopted or changed.
[Collection("Plugin singleton")]
public class ListsCreateIdentityTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    // The first attempt died before Jellyfin made anything; meanwhile another collection manager (or the caller, by
    // hand) made a list of the same name. The retry must not put its entries into that list.
    [Theory]
    [InlineData(ListKinds.Playlist, false)]
    [InlineData(ListKinds.Playlist, true)]
    [InlineData(ListKinds.Collection, false)]
    [InlineData(ListKinds.Collection, true)]
    public async Task ANamesakeMadeAfterAFailedCreateIsNeverAdopted(string kind, bool byTheCaller)
    {
        using var h = new ListsHarness();
        var caller = h.NewUser("manager", collections: true);
        var other = h.NewUser("other", collections: true);
        var item = h.Host.AddItem();
        var entries = new[] { new ApplyEntry(0, item, null) };
        h.Host.FailCreates = new IOException("the server stopped");

        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(caller, kind, "Movie night", false, entries, K("create-1"), None));
        h.Host.FailCreates = null;
        var maker = byTheCaller ? caller : other;
        var namesake = kind == ListKinds.Playlist
            ? (await h.Host.CreateHandMadePlaylistAsync("Movie night", maker.Id))
            : (await h.Host.CreateHandMadeCollectionAsync("Movie night"));
        var hidden = h.Host.AddItem();
        h.Host.Lists[namesake].Raw.Add(new RawEntry(hidden, true));
        h.Host.Hide(hidden, caller);

        var retry = await h.Service.CreateListAsync(caller, kind, "Movie night", false, entries, K("create-1"), None);

        // The namesake keeps exactly what it had.
        Assert.Equal(new[] { hidden }, h.Host.Resolved(namesake));
        if (retry.StatusCode == 200)
        {
            Assert.NotEqual(namesake.ToString("N"), Assert.IsType<CreateListResultDto>(retry.Value).ListId);
        }
        else
        {
            // Collections share Jellyfin's folder per name: the second create is refused rather than merged into the first.
            Assert.Equal(ListKinds.Collection, kind);
            Error(retry, 409, "name_taken");
        }
    }

    // Jellyfin keeps one folder per collection name, so creating a collection whose name is taken would make Jellyfin
    // replace the existing collection (same item id, its members wiped). JE refuses instead and changes nothing.
    [Fact]
    public async Task ACollectionCreateWithTheNameOfAnExistingCollectionIsRefusedAndTheOtherIsUntouched()
    {
        using var h = new ListsHarness();
        var manager = h.NewUser("manager", collections: true);
        var existing = await h.Host.CreateHandMadeCollectionAsync("Heist films");
        var member = h.Host.AddItem();
        h.Host.Lists[existing].Raw.Add(new RawEntry(member, true));
        h.Host.Hide(member, manager);
        h.Host.ListHiddenFrom[manager.Id] = new HashSet<Guid> { existing };
        h.Host.Calls.Clear();

        Error(await h.Service.CreateListAsync(manager, ListKinds.Collection, "heist Films", false, new[] { new ApplyEntry(0, h.Host.AddItem(), null) }, K("create-heist"), None), 409, "name_taken");

        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("create-collection", StringComparison.Ordinal));
        Assert.Equal(new[] { member }, h.Host.Resolved(existing));
    }

    // The first attempt died after Jellyfin made the list (with the operation's marker) but before it was recorded; a
    // namesake was made by hand meanwhile. The retry continues with the marked list only.
    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task ARetryAfterACrashBetweenJellyfinsCreateAndItsRecordContinuesWithTheMarkedListOnly(string kind)
    {
        using var h = new ListsHarness();
        var user = h.NewUser("user", collections: true);
        var item = h.Host.AddItem();
        var entries = new[] { new ApplyEntry(0, item, null) };
        h.Host.AfterCreate = _ => throw new IOException("the server stopped");
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(user, kind, "Watch next", false, entries, K("create-crash"), None));
        h.Host.AfterCreate = null;
        var made = Assert.Single(h.Host.Lists.Values, l => l.Info.Kind == kind).Info.Id;
        if (kind == ListKinds.Playlist)
        {
            // The caller's own namesake, made by hand: a playlist of the same name is its own list in Jellyfin.
            await h.Host.CreateHandMadePlaylistAsync("Watch next", user.Id);
        }

        var retry = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, kind, "Watch next", false, entries, K("create-crash"), None));

        Assert.Equal(made.ToString("N"), retry.ListId);
        Assert.Equal(new[] { item }, h.Host.Resolved(made));
        Assert.All(h.Host.Lists.Values.Where(l => l.Info.Id != made), l => Assert.Empty(l.Raw));
        // The list got its chosen name, and never had a share for a person who doesn't exist.
        Assert.Equal("Watch next", h.Host.GetList(made)!.Name);
        Assert.All(h.Host.GetList(made)!.Shares, s => Assert.NotNull(h.Users.Object.GetUserById(s.UserId)));
    }

    // A recovered list still needs the caller's current right to edit it.
    [Fact]
    public async Task ARecoveredCollectionTheCallerCantSeeAnyMoreIsNotContinued()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("user", collections: true);
        var item = h.Host.AddItem();
        var entries = new[] { new ApplyEntry(0, item, null) };
        h.Host.AfterCreate = _ => throw new IOException("the server stopped");
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(user, ListKinds.Collection, "Mine", false, entries, K("create-lost"), None));
        h.Host.AfterCreate = null;
        var made = Assert.Single(h.Host.Lists.Values).Info.Id;
        h.Host.ListHiddenFrom[user.Id] = new HashSet<Guid> { made };

        Error(await h.Service.CreateListAsync(user, ListKinds.Collection, "Mine", false, entries, K("create-lost"), None), 404, "not_found");

        Assert.Empty(h.Host.Resolved(made));
        Assert.Single(h.Host.Calls, c => c.StartsWith("create-collection", StringComparison.Ordinal));
    }

    // 4c1-view-replay-r2: a completed create answered again after the caller lost the list while its statuses loaded.
    [Fact]
    public async Task ACreateReplayedAfterTheCallerLostTheListWhileItsStatusesLoadedAnswersNotFound()
    {
        using var h = new ListsHarness(status: true);
        h.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
        h.Status.ByKey["movie:tmdb:930"] = "{\"stage\":\"asked\"}";
        var user = h.NewUser("user", collections: true);
        var entries = new[] { new ApplyEntry(0, null, Movie(930, "2020-01-01")) };
        var created = Ok<CreateListResultDto>(await h.Service.CreateListAsync(user, ListKinds.Collection, "Asked", false, entries, K("create-replay"), None));
        var listId = Guid.Parse(created.ListId);
        h.Status.During = () => h.Host.ListHiddenFrom[user.Id] = new HashSet<Guid> { listId };

        var replay = await h.Service.CreateListAsync(user, ListKinds.Collection, "Asked", false, entries, K("create-replay"), None);

        Assert.True(replay.StatusCode == 404 || (replay.Value is CreateListResultDto dto && dto.Result.View == null), $"answered {replay.StatusCode} with a view");
    }
}
