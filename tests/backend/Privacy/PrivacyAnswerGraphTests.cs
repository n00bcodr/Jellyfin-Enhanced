using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;

namespace JE.Tests;

/// <summary>
/// The one recursive walk over an answer's graph (<see cref="PrivacyAnswerGraph"/>): members at any depth, the host's
/// shared collections never edited, lazy sequences delivered materialized, an unprojectable member refused, and the
/// host's own WebSocket message types (only the session list carries a title member).
/// </summary>
public class PrivacyAnswerGraphTests
{
    /// <summary>A container shaped like a host DTO that holds titles in a read-only list and a lazy sequence.</summary>
    public sealed class Envelope
    {
        public IReadOnlyList<BaseItemDto> Queue { get; set; } = [];
        public IEnumerable<BaseItemDto> Lazy { get; set; } = [];
        public SessionInfoDto? Session { get; set; }
    }

    public sealed class Sealed
    {
        public BaseItemDto? Item { get; } = new() { Id = Guid.NewGuid(), Name = "fixed" };
    }

    private static BaseItemDto Dto(string name, BaseItemDto? program = null) => new() { Id = Guid.NewGuid(), Name = name, CurrentProgram = program };

    [Theory]
    [InlineData(typeof(SessionInfoDto), true)]
    [InlineData(typeof(List<SessionInfoDto>), true)]
    [InlineData(typeof(QueryResult<BaseItemDto>), true)]
    [InlineData(typeof(MediaBrowser.Model.LiveTv.TimerInfoDto), true)]
    [InlineData(typeof(MediaBrowser.Controller.Authentication.AuthenticationResult), true)]
    [InlineData(typeof(MediaBrowser.Model.Dto.MediaSourceInfo), false)]
    [InlineData(typeof(SearchHintResult), false)]
    [InlineData(typeof(MediaBrowser.Controller.Entities.Movies.Movie), false)]
    public void TheWalkKnowsWhichHostTypesCanHoldATitleMember(Type type, bool reaches) => Assert.Equal(reaches, PrivacyAnswerGraph.Reaches(type));

    [Fact]
    public void MembersAreFoundAtAnyDepth()
    {
        var deepest = Dto("programme 3");
        var answer = new List<SessionInfoDto> { new() { Id = "s", NowPlayingItem = Dto("channel", Dto("programme 2", deepest)) } };
        var found = NativePrivacyProjection.Nested(answer);
        Assert.Equal(["channel", "programme 2", "programme 3"], found.Select(f => f.Dto.Name));
        Assert.True(found[0].KeepsControls);
        Assert.False(found[1].KeepsControls);
    }

    [Fact]
    public void AHostSharedCollectionIsReplacedByAPrivateCopyNeverEdited()
    {
        var shared = new[] { Dto("keep"), Dto("drop") };
        var envelope = new Envelope { Queue = shared };
        PrivacyAnswerGraph.Rewrite(envelope, null, (dto, _) => dto.Name == "drop" ? null : dto);
        Assert.Equal(["keep", "drop"], shared.Select(d => d.Name));
        Assert.Equal(["keep"], envelope.Queue.Select(d => d!.Name));
    }

    [Fact]
    public void ALazySequenceIsDeliveredMaterializedSoItsProjectionSticks()
    {
        var envelope = new Envelope { Lazy = Enumerable.Range(0, 2).Select(i => Dto("lazy " + i)) };
        PrivacyAnswerGraph.Rewrite(envelope, null, (dto, _) => new BaseItemDto { Id = dto.Id, Name = "projected" });
        Assert.All(envelope.Lazy, d => Assert.Equal("projected", d.Name));
        Assert.IsType<BaseItemDto[]>(envelope.Lazy);
    }

    [Fact]
    public void AMemberThatCannotBeReplacedIsRefusedNotDelivered()
        => Assert.Throws<InvalidOperationException>(() => PrivacyAnswerGraph.Rewrite(new Sealed(), null, (_, _) => null));

    [Fact]
    public void ListedItemsAreWalkedInPlaceAndNeverVisited()
    {
        var program = Dto("programme");
        var channel = Dto("channel", program);
        var visited = new List<string?>();
        PrivacyAnswerGraph.Rewrite(new QueryResult<BaseItemDto>(0, 1, [channel]), new HashSet<object>([channel], ReferenceEqualityComparer.Instance),
            (dto, _) => { visited.Add(dto.Name); return null; });
        Assert.Equal(["programme"], visited);
        Assert.Null(channel.CurrentProgram);
    }

    /// <summary>
    /// Host evidence (12.2 under jf12, 10.11.11 under jf10): of every outbound WebSocket message type the host defines,
    /// only the session list ("Sessions") can carry a title member, and the plugin's session listener projects it. The
    /// activity-log message carries no entries (the dashboard re-reads the projected REST answer), timer events carry ids.
    /// </summary>
    [Fact]
    public void OnlyTheHostsSessionsMessageCarriesATitleMember()
    {
        var outbound = typeof(MediaBrowser.Controller.Session.ISessionManager).Assembly.GetTypes()
            .Where(t => t is { IsClass: true, IsAbstract: false } && t.Namespace?.EndsWith("WebSocketMessages.Outbound", StringComparison.Ordinal) == true)
            .ToArray();
        Assert.NotEmpty(outbound);
        var carrying = outbound.Where(PrivacyAnswerGraph.Reaches).Select(t => t.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();
        Assert.Equal(["SessionsMessage"], carrying);
    }
}
