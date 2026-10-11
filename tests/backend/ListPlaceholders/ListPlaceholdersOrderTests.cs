using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using O = Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.ListPlaceholderOrder;

namespace JE.Tests;

// Order algebra: tokens, reconcile, projection, projection merge, renumbering and both Jellyfin coordinate systems.
// Expected values are written out by hand (never computed with the production functions).
public class ListPlaceholdersOrderTests
{
    private static readonly Guid A = Guid.Parse("aaaaaaaa-0000-0000-0000-000000000001");
    private static readonly Guid B = Guid.Parse("bbbbbbbb-0000-0000-0000-000000000002");
    private static readonly Guid C = Guid.Parse("cccccccc-0000-0000-0000-000000000003");
    private static readonly Guid D = Guid.Parse("dddddddd-0000-0000-0000-000000000004");

    private const string A0 = "e:aaaaaaaa000000000000000000000001:0";
    private const string A1 = "e:aaaaaaaa000000000000000000000001:1";
    private const string B0 = "e:bbbbbbbb000000000000000000000002:0";
    private const string C0 = "e:cccccccc000000000000000000000003:0";
    private const string D0 = "e:dddddddd000000000000000000000004:0";
    private const string P1 = "p:11111111111111111111111111111111";
    private const string P2 = "p:22222222222222222222222222222222";
    private const string P3 = "p:33333333333333333333333333333333";
    private static readonly string Id1 = P1[2..];
    private static readonly string Id2 = P2[2..];
    private static readonly string Id3 = P3[2..];

    [Fact]
    public void RealTokensAreCanonicalAndNumberDuplicatesByAppearance()
    {
        Assert.Equal(A0, O.RealToken(A, 0));
        Assert.Equal(new[] { A0, B0, A1 }, O.BuildRealTokens(new[] { A, B, A }));
        Assert.True(O.TryParseReal(A1, out var id, out var k));
        Assert.Equal((A, 1), (id, k));
        Assert.False(O.IsReal(A0.ToUpperInvariant().Replace("E:", "e:")));
        Assert.False(O.IsReal("e:aaaaaaaa000000000000000000000001:01"));
        Assert.False(O.IsReal("e:aaaaaaaa000000000000000000000001:-1"));
        Assert.False(O.IsReal("e:aaaaaaaa00000000000000000000001:0"));
        Assert.False(O.IsReal("e:aaaaaaaa-0000-0000-0000-000000000001:0"));
        Assert.False(O.IsReal(P1));
        Assert.True(O.IsPlaceholder(P1));
        Assert.Equal(Id1, O.PlaceholderIdOf(P1));
        Assert.Null(O.PlaceholderIdOf(A0));
    }

    [Fact]
    public void RealTokensSkipDanglingLinks()
    {
        var raw = new[] { new RawEntry(A, true), new RawEntry(D, false), new RawEntry(B, true), new RawEntry(null, false), new RawEntry(A, true) };
        Assert.Equal(new[] { A0, B0, A1 }, O.BuildRealTokens(raw));
    }

    [Fact]
    public void ReconcileKeepsPlaceholdersAfterTheirAnchor()
    {
        var stored = new[] { P1, A0, P2, B0, P3, C0 };
        var result = O.Reconcile(stored, new[] { A0, B0, C0 }, new[] { Id1, Id2, Id3 });
        Assert.Equal(stored, result);
    }

    [Fact]
    public void ReconcileReanchorsToTheNearestPrecedingSurvivingRealEntry()
    {
        // B was removed in Jellyfin: P3 (after B) follows A, the nearest earlier real entry that still exists.
        var result = O.Reconcile(new[] { A0, P2, B0, P3, C0 }, new[] { A0, C0 }, new[] { Id2, Id3 });
        Assert.Equal(new[] { A0, P2, P3, C0 }, result);
    }

    [Fact]
    public void ReconcileMovesPlaceholdersToTheStartWhenNoAnchorSurvives()
    {
        var result = O.Reconcile(new[] { A0, P1, B0, P2 }, new[] { C0 }, new[] { Id1, Id2 });
        Assert.Equal(new[] { P1, P2, C0 }, result);
    }

    [Fact]
    public void ReconcileFollowsJellyfinsRealOrderAndCarriesAnchoredPlaceholders()
    {
        // Natively, C moved to the front and D was added at the end.
        var result = O.Reconcile(new[] { A0, P1, B0, C0, P2 }, new[] { C0, A0, B0, D0 }, new[] { Id1, Id2 });
        Assert.Equal(new[] { C0, P2, A0, P1, B0, D0 }, result);
    }

    [Fact]
    public void ReconcileAppendsUnknownPlaceholdersAndDropsDeletedOrRepeatedOnes()
    {
        var result = O.Reconcile(new[] { P1, A0, P1, P2, "p:deleted", "junk" }, new[] { A0 }, new[] { Id1, Id3 });
        Assert.Equal(new[] { P1, A0, P3 }, result);
    }

    [Fact]
    public void RelabelRenumbersOccurrencesByAppearance()
    {
        Assert.Equal(new[] { A0, P1, B0, A1 }, O.Relabel(new[] { A1, P1, B0, A0 }));
    }

    [Fact]
    public void ProjectionDropsTokensTheCallerMayNotSee()
    {
        var canonical = new[] { P1, A0, P2, B0, C0 };
        Assert.Equal(new[] { P1, A0, C0 }, O.Project(canonical, t => t != P2 && t != B0));
    }

    [Fact]
    public void MergeAcceptsPlaceholderOnlyMovesAndKeepsHiddenTokensAnchored()
    {
        // Canonical [A P1 B(h) P2 C]; caller can't see B. Caller moves P2 to the front.
        var canonical = new[] { A0, P1, B0, P2, C0 };
        var projection = new[] { A0, P1, P2, C0 };
        var merge = O.MergeProjection(canonical, projection, new[] { P2, A0, P1, C0 }, null);
        Assert.True(merge.Ok);
        Assert.False(merge.RealMoved);
        // B stays right after its anchor P1.
        Assert.Equal(new[] { P2, A0, P1, B0, C0 }, merge.Desired);
    }

    [Fact]
    public void MergeAcceptsOneMovedRealRowAndDoesNotDragHiddenRowsAlong()
    {
        // Canonical [A H B]; H hidden from the caller; caller moves A after B.
        var canonical = new[] { A0, D0, B0 };
        var merge = O.MergeProjection(canonical, new[] { A0, B0 }, new[] { B0, A0 }, A0);
        Assert.True(merge.Ok);
        Assert.True(merge.RealMoved);
        Assert.Equal(new[] { D0, B0, A0 }, merge.Desired);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("duplicate")]
    public void MergeRejectsAnythingButAPermutation(string variant)
    {
        var projection = new[] { A0, P1, B0 };
        string[] requested = variant switch
        {
            "missing" => new[] { A0, P1 },
            "extra" => new[] { A0, P1, B0, P2 },
            _ => new[] { A0, P1, P1 },
        };
        var merge = O.MergeProjection(projection, projection, requested, null);
        Assert.False(merge.Ok);
        Assert.Equal("not_permutation", merge.Error);
    }

    [Fact]
    public void MergeRejectsRealReordersWithoutMovedAndMoreThanOneMovedRow()
    {
        var projection = new[] { A0, B0, C0 };
        Assert.Equal("real_order_changed", O.MergeProjection(projection, projection, new[] { B0, A0, C0 }, null).Error);
        // A and C swapped: removing the moved token still leaves a different order.
        Assert.Equal("real_order_changed", O.MergeProjection(projection, projection, new[] { C0, B0, A0 }, A0).Error);
        Assert.Equal("moved_invalid", O.MergeProjection(projection, projection, new[] { A0, B0, C0 }, P1).Error);
        Assert.Equal("moved_invalid", O.MergeProjection(projection, projection, new[] { A0, B0, C0 }, D0).Error);
    }

    [Fact]
    public void MergeTreatsAnUnmovedRealTokenAsAPlaceholderOnlyChange()
    {
        var projection = new[] { A0, P1, B0 };
        var merge = O.MergeProjection(projection, projection, new[] { P1, A0, B0 }, A0);
        Assert.True(merge.Ok);
        Assert.False(merge.RealMoved);
    }

    [Fact]
    public void MergeRefusesMovingANonFirstCopyOfADuplicatedItem()
    {
        var projection = new[] { A0, B0, A1 };
        var merge = O.MergeProjection(projection, projection, new[] { A1, A0, B0 }, A1);
        Assert.False(merge.Ok);
        Assert.Equal("duplicate_copy", merge.Error);
        Assert.True(O.MergeProjection(projection, projection, new[] { B0, A0, A1 }, A0).Ok);
    }

    [Fact]
    public void InsertRealItemsRenumbersLaterCopies()
    {
        var (order, inserted) = O.InsertRealItems(new[] { B0, P1, A0 }, 1, new[] { A, C });
        Assert.Equal(new[] { B0, A0, C0, P1, A1 }, order);
        Assert.Equal(new[] { A0, C0 }, inserted);

        var (atEnd, last) = O.InsertRealItems(new[] { A0 }, 99, new[] { A });
        Assert.Equal(new[] { A0, A1 }, atEnd);
        Assert.Equal(new[] { A1 }, last);
    }

    [Fact]
    public void RealAnchorBeforeFindsTheNearestEarlierRealEntry()
    {
        var order = new[] { P1, A0, P2, P3, B0 };
        Assert.Null(O.RealAnchorBefore(order, 1));
        Assert.Equal(A0, O.RealAnchorBefore(order, 4));
        Assert.Equal(B0, O.RealAnchorBefore(order, 5));
    }

    [Fact]
    public void RawInsertPositionCountsDanglingLinksAndOccurrences()
    {
        // raw: [dangling, A, B, dangling, A]
        var raw = new[] { new RawEntry(D, false), new RawEntry(A, true), new RawEntry(B, true), new RawEntry(C, false), new RawEntry(A, true) };
        Assert.Equal(0, O.RawInsertPosition(raw, null));
        Assert.Equal(2, O.RawInsertPosition(raw, A0));
        Assert.Equal(5, O.RawInsertPosition(raw, A1));
        Assert.Equal(3, O.RawInsertPosition(raw, B0));
        Assert.Null(O.RawInsertPosition(raw, C0)); // only a dangling link with that id: not an anchor
        Assert.Null(O.RawInsertPosition(raw, "junk"));
    }

    [Fact]
    public void CollectionsSortByReleaseDateWithTbaLast()
    {
        var items = new[]
        {
            new Placeholder { Id = "1", Title = "Zed", ReleaseDate = null },
            new Placeholder { Id = "2", Title = "Beta", ReleaseDate = "2021-01-01" },
            new Placeholder { Id = "3", Title = "alpha", ReleaseDate = "2021-01-01" },
            new Placeholder { Id = "4", Title = "Old", ReleaseDate = "1999-05-05" },
            new Placeholder { Id = "5", Title = "Abc", ReleaseDate = null },
        };
        Assert.Equal(new[] { "4", "3", "2", "5", "1" }, O.SortForCollection(items).Select(p => p.Id));
    }
}
