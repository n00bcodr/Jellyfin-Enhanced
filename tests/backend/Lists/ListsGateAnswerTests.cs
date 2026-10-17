using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 2 (4c1-r2-security-4): an editor's share is removed while Jellyfin takes the items of their apply. What
// Jellyfin took is the write's result and is answered (and recorded); the list is not (no view), the editor's new
// placeholders are not kept (skipped as accessLost), and nothing more is written as the owner (Jellyfin 10.11: the
// moves that would place the appended item).
[Collection("Plugin singleton")]
public class ListsGateAnswerTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AShareRemovedWhileJellyfinTakesTheItemsAnswersTheResultsWithoutTheList(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var first = h.Host.AddItem();
        var added = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        playlist.Raw.Add(new RawEntry(first, true));
        var access = h.AccessFor(playlist, editor);
        var placeholder = Movie(31, "2020-01-01");
        h.Host.AfterAdd = _ => playlist.Info = playlist.Info with { Shares = Array.Empty<ListShare>() };

        var result = Ok<ApplyResultDto>(await h.Service.ApplyAsync(
            access,
            new[] { new ApplyEntry(0, added, null), new ApplyEntry(1, null, placeholder) },
            new PositionDto { AtStart = true },
            null,
            K("revoked-during-add"),
            None,
            recheckAccess: true));

        Assert.Null(result.View);
        Assert.Equal(new[] { added.ToString("N") }, result.AddedAsItems);
        Assert.Empty(result.Added);
        Assert.Equal((1, "accessLost"), (Assert.Single(result.Skipped).Index, result.Skipped[0].Reason));
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("move:", StringComparison.Ordinal));
        Assert.Contains(added, h.Host.Resolved(playlist.Info.Id));
        var doc = h.Store.Load(access.ListIdN);
        Assert.DoesNotContain(doc?.Items ?? new List<Placeholder>(), p => p.Id == placeholder.Id);

        // The same request again (a retry): answered as the caller may see the list now, which is not at all.
        Error(await h.Service.ApplyAsync(access, new[] { new ApplyEntry(0, added, null), new ApplyEntry(1, null, placeholder) }, new PositionDto { AtStart = true }, null, K("revoked-during-add"), None, recheckAccess: true), 404, "not_found");
    }
}
