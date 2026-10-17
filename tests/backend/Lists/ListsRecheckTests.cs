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

    // The general sweep: what a caller may see is read again under the lock with the rights the change uses.
    private sealed class Rated : IDisposable
    {
        public ListsHarness H { get; } = new(seerr: true);
        public Jellyfin.Database.Implementations.Entities.User Owner { get; }
        public ListAccess Access { get; }
        public Placeholder Kept { get; } = Movie(910, "2020-01-01");
        public Placeholder RatedR { get; } = Movie(911, "2020-01-01");

        public Rated()
        {
            H.MovieCertifications[910] = "G";
            H.MovieCertifications[911] = "R";
            H.MovieCertifications[912] = "R";
            Owner = H.NewUser("owner");
            Access = H.AccessFor(H.Host.AddPlaylist(Owner), Owner);
            Ok<ApplyResultDto>(H.Service.AddPlaceholdersAsync(Access, new[] { Kept, RatedR }, null, null, null, None).GetAwaiter().GetResult());
        }

        public int Rev => H.Store.Load(Access.ListIdN)!.Rev;

        // Starts a change while the list is locked, gives the owner a parental limit while it waits, then lets it run.
        public async Task<ListOutcome> WhileLimited(Func<Task<ListOutcome>> change)
        {
            Task<ListOutcome> running;
            using (await H.Store.LockAsync(Access.ListIdN))
            {
                running = change();
                Assert.False(running.IsCompleted);
                Owner.MaxParentalRatingScore = 10;
            }

            return await running;
        }

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public async Task ADeleteOrNoteOnAnEntryALimitHidMeanwhileIsNotFoundAndChangesNothing()
    {
        using var r = new Rated();
        var rev = r.Rev;

        Error(await r.WhileLimited(() => r.H.Service.DeleteAsync(r.Access, r.RatedR.Id, rev, null, None)), 404, "not_found");
        r.Owner.MaxParentalRatingScore = null;
        Error(await r.WhileLimited(() => r.H.Service.PatchAsync(r.Access, r.RatedR.Id, rev, "note", null, null, None)), 404, "not_found");

        var doc = r.H.Store.Load(r.Access.ListIdN)!;
        Assert.Equal(rev, doc.Rev);
        Assert.Null(doc.Items.Single(p => p.Id == r.RatedR.Id).Note);
    }

    [Fact]
    public async Task LinkingACustomEntryToATitleALimitBlocksMeanwhileIsRefused()
    {
        using var r = new Rated();
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Mine\"}", r.Owner.Id.ToString("N"));
        Ok<ApplyResultDto>(await r.H.Service.AddPlaceholdersAsync(r.Access, new[] { custom }, null, null, null, None));
        var rev = r.Rev;
        // The limit arrives while the linked title's poster is read (after the check before the lock).
        var reply = r.H.Reply;
        r.H.ReplyAsync = (request, _) =>
        {
            r.Owner.MaxParentalRatingScore = 10;
            return Task.FromResult(reply(request));
        };

        Error(await r.H.Service.PatchAsync(r.Access, custom.Id, rev, null, Movie(912, "2020-01-01"), null, None), 403, "parental_block");
        Assert.Equal(PlaceholderKinds.Custom, r.H.Store.Load(r.Access.ListIdN)!.Items.Single(p => p.Id == custom.Id).Kind);
    }

    [Fact]
    public async Task TheSwapInSwitchsAnswerLeavesOutWhatALimitHidMeanwhile()
    {
        using var r = new Rated();
        var rev = r.Rev;

        var view = Ok<ListViewDto>(await r.WhileLimited(() => r.H.Service.SetSwapInAsync(r.Access, rev, true, null, None)));

        Assert.Equal(new[] { r.Kept.Id }, view.Placeholders.Select(p => p.Id));
    }
}
