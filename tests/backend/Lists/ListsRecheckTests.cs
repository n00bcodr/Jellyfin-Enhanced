using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 1 (4c1): what an apply accepted before the list lock (the caller's parental limits, which items they and the
// owner can open) is checked again under the lock with the rights it writes with, failing closed.
[Collection("Plugin singleton")]
public class ListsRecheckTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Fact]
    public async Task LimitsAndAccessChangedWhileAnApplyValidatedAreCheckedAgainBeforeAnythingIsWritten()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[900] = "R";
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var direct = h.Host.AddItem();
        var expanded = h.Host.AddItem(tmdb: 901); // a placeholder for it goes in as this library item
        var rated = Movie(900);
        var inLibrary = Movie(901);

        // While the entries' posters are read (after validation, before the lock) the owner gets a parental limit and
        // loses access to both library items.
        var reply = h.Reply;
        var changed = false;
        h.ReplyAsync = (request, _) =>
        {
            if (!changed)
            {
                changed = true;
                owner.MaxParentalRatingScore = 10;
                h.Host.Hide(direct, owner);
                h.Host.Hide(expanded, owner);
            }

            return Task.FromResult(reply(request));
        };

        var result = Ok<ApplyResultDto>(await h.Service.ApplyAsync(
            access,
            new[] { new ApplyEntry(0, direct, null), new ApplyEntry(1, null, inLibrary), new ApplyEntry(2, null, rated) },
            null,
            null,
            K("apply-1"),
            None,
            recheckAccess: true));

        Assert.True(changed);
        Assert.Empty(result.Added);
        Assert.Empty(result.AddedAsItems);
        Assert.Equal(new[] { (0, "notVisible"), (1, "notVisible"), (2, "blocked") }, result.Skipped.OrderBy(s => s.Index).Select(s => (s.Index, s.Reason)));
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)?.Items ?? new List<Placeholder>());
    }
}
