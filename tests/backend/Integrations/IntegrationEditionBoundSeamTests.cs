using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Entities;
using Microsoft.Extensions.Logging;

namespace JE.Tests;

/// <summary>
/// The copy scan bound itself, with the bounds lowered (they are far beyond any real library): only rows the viewer
/// may observe count, a lookup that reaches it tells the flow's watches and reports no copy, and it is logged once per
/// title per hour with the bound and counts.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionBoundSeamTests
{
    private static readonly TitleKey Matrix = TitleKey.Parse("movie:tmdb:603")!;

    private sealed class Logged : ILogger<ArrJellyfinView>
    {
        public List<string> Lines { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => Lines.Add(logLevel + " " + formatter(state, exception));
    }

    private static BaseItem Copy(IntegrationEditionOrphanTests.Library l, Folder root, int n)
    {
        var row = new IntegrationEditionOrphanTests.MovieFile { Id = Guid.NewGuid(), Name = $"0 copy {n}", Path = $"/media/{root.Name}/{n}.mkv" };
        l.Items[row.Id] = row; l.Parents[row.Id] = new() { root };
        return row;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OnlyRowsTheViewerMayObserveReachTheBound(bool libraryContext)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = libraryContext ? StatusViewer.Library : l.Person(rig.Member);
        l.View.ObservableBound = 2;
        // Full pages of retained rows, and live rows in a library only the server may open, never count (the hidden
        // rows still are copies of the title, kept as policy facts within the 20-copy budget).
        IntegrationEditionBoundTests.Rows(l, libraryContext ? 150 : 90, hidden: libraryContext ? 0 : 15);
        using (var watch = CopyLookupBound.Track())
        {
            var copies = l.View.Copies(Matrix, viewer);
            Assert.Equal(CopyLookupOutcome.Found, copies.Outcome);
            Assert.Contains(copies.Seen, c => c.ItemId == l.Uhd.Id && c.Visible);
            Assert.False(watch.Reached);
        }
        // Three copies the viewer may open on a full first page: the bound, an incomplete answer with the three it saw
        // (pages show none), the watch is told.
        var rows = IntegrationEditionBoundTests.Rows(l, 120);
        var first = new[] { Copy(l, l.HdRoot, 1), Copy(l, l.HdRoot, 2), Copy(l, l.HdRoot, 3) };
        rows.InsertRange(0, first);
        using var outer = CopyLookupBound.Track();
        using (var inner = CopyLookupBound.Track())
        {
            var bounded = l.View.Copies(Matrix, viewer);
            Assert.Equal(CopyLookupOutcome.Incomplete, bounded.Outcome);
            Assert.Empty(bounded.Display);
            Assert.Equal(first.Select(r => r.Id), bounded.Seen.Where(c => c.Visible).Select(c => c.ItemId));
            Assert.True(inner.Reached);
        }
        Assert.True(outer.Reached);
        Assert.True(CopyLookupBound.Reached);
    }

    [Fact]
    public async Task AWatchSeesBoundsReachedInTheWorkItAwaitsAndEndsWithIt()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        l.View.PageCeiling = 1;
        IntegrationEditionBoundTests.Rows(l, 150, live: false);
        Assert.False(CopyLookupBound.Reached);
        using (var watch = CopyLookupBound.Track())
        {
            await Task.Run(async () =>
            {
                await Task.Yield();
                Assert.Equal(CopyLookupOutcome.Incomplete, l.View.Copies(Matrix, StatusViewer.Library).Outcome);
            });
            Assert.True(watch.Reached);
        }
        Assert.False(CopyLookupBound.Reached);
        // A lookup outside any watch still answers (nothing to tell).
        Assert.Equal(CopyLookupOutcome.Incomplete, l.View.Copies(Matrix, StatusViewer.Library).Outcome);
        using var after = CopyLookupBound.Track();
        Assert.False(after.Reached);
    }

    [Fact]
    public void ABoundIsLoggedOncePerTitlePerHourWithItsCountsAndNoPaths()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        var log = new Logged();
        var now = new DateTimeOffset(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);
        using var view = new ArrJellyfinView(l.Manager.Object, l.Users.Object, log) { PageCeiling = 1, Clock = () => now };
        IntegrationEditionBoundTests.Rows(l, 150, live: false);
        for (var n = 0; n < 3; n++) Assert.Equal(CopyLookupOutcome.Incomplete, view.Copies(Matrix, StatusViewer.Library).Outcome);
        var line = Assert.Single(log.Lines);
        Assert.Equal("Warning Jellyfin copy lookup for movie:tmdb:603 reached its work ceiling of 1 native pages (1 pages, 100 native rows, 0 observable rows, 0 eligible copies, 1 of 1 provider queries); this read is incomplete (absence not proven) and is not cached.", line);
        Assert.DoesNotContain("/removed", line);
        now += TimeSpan.FromMinutes(59);
        view.Copies(Matrix, StatusViewer.Library);
        Assert.Single(log.Lines);
        now += TimeSpan.FromMinutes(2);
        view.Copies(Matrix, StatusViewer.Library);
        Assert.Equal(2, log.Lines.Count);
        // Each title on its own.
        IntegrationEditionBoundTests.Rows(l, 150, live: false, id: "604");
        view.Copies(TitleKey.Parse("movie:tmdb:604")!, StatusViewer.Library);
        Assert.Equal(3, log.Lines.Count);
    }

    [Fact]
    public void ALookupIsAValueThatNeverPassesForAListOfCopies()
    {
        // The type forces each reader to choose: Display (pages), IsProvenAbsent (absence), Seen (facts). It is no
        // list, so an incomplete answer can't be read as "no copies" by accident.
        Assert.False(typeof(System.Collections.IEnumerable).IsAssignableFrom(typeof(CopyLookup)));
        var open = new JfCopy { ItemId = Guid.NewGuid(), Visible = true };
        var hidden = new JfCopy { ItemId = Guid.NewGuid() };
        Assert.Same(CopyLookup.Absent, CopyLookup.Complete(Array.Empty<JfCopy>()));
        Assert.True(CopyLookup.Absent.IsProvenAbsent && CopyLookup.Absent.IsComplete);
        var found = CopyLookup.Complete(new[] { hidden, open });
        Assert.Equal((CopyLookupOutcome.Found, false, true), (found.Outcome, found.IsProvenAbsent, found.IsComplete));
        Assert.Equal(new[] { hidden, open }, found.Display);
        Assert.Same(open, found.SeenOpenable);
        foreach (var seen in new[] { Array.Empty<JfCopy>(), new[] { hidden }, new[] { hidden, open } })
        {
            var incomplete = CopyLookup.Incomplete(seen);
            Assert.Equal((CopyLookupOutcome.Incomplete, false, false), (incomplete.Outcome, incomplete.IsProvenAbsent, incomplete.IsComplete));
            Assert.Empty(incomplete.Display);
            Assert.Equal(seen, incomplete.Seen);
            Assert.Equal(seen.Contains(open) ? open : null, incomplete.SeenOpenable);
        }
    }
}
