using System.Net;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace JellyfinEnhanced.Tests;

public sealed class PrivacyIdentityTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "je-identity-" + Guid.NewGuid());
    private readonly Mock<IUserManager> _users = new();
    private readonly Mock<ISessionManager> _sessions = new();
    private readonly SpoilerIdentityService _markers;
    private readonly RequestIdentityService _identity;
    private static int _ipCounter;
    private readonly IPAddress _ip = IPAddress.Parse("198.18." + (Interlocked.Increment(ref _ipCounter) / 250) + "." + (_ipCounter % 250 + 1));
    private readonly Guid _alice = Guid.NewGuid();
    private readonly Guid _bob = Guid.NewGuid();

    public PrivacyIdentityTests()
    {
        Directory.CreateDirectory(_directory);
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(x => x.LogDirectoryPath).Returns(_directory);
        var logger = new Logger(paths.Object, NullLoggerFactory.Instance);
        SetUsers(_alice, _bob);
        _sessions.SetupGet(x => x.Sessions).Returns(Array.Empty<SessionInfo>());
        _markers = new SpoilerIdentityService(_users.Object, logger);
        _identity = new RequestIdentityService(_sessions.Object, _users.Object, _markers, logger);
    }

    private void SetUsers(params Guid[] ids)
    {
#if NET9_0
        _users.SetupGet(x => x.Users).Returns(ids.Select(User).ToArray());
#else
        _users.Setup(x => x.GetUsers()).Returns(ids.Select(User).ToArray());
#endif
    }

    private static User User(Guid id) => new("test", "default", "default") { Id = id };
    private DefaultHttpContext Context() { var context = new DefaultHttpContext(); context.Connection.RemoteIpAddress = _ip; return context; }
    private SessionInfo Session(Guid id, string? endpoint = null) => new(_sessions.Object, NullLogger.Instance) { UserId = id, RemoteEndPoint = endpoint ?? _ip + ":8096" };

    [Fact]
    public void AuthenticatedIdentityOverridesOtherUsersMarkerAndCookie()
    {
        var context = Context();
        context.User = PrivacyPolicyTests.Principal(_alice);
        context.Request.QueryString = new QueryString("?tag=abc-jeu" + _markers.MintMarker(_bob));
        context.Request.Headers.Cookie = "je-spoiler-uid=" + _bob;
        var result = _identity.Resolve(context);
        Assert.Equal(IdentityConfidence.Authenticated, result.Confidence);
        Assert.Equal(new[] { _alice }, result.Candidates);
        Assert.Empty(_users.Invocations);
        _sessions.VerifyGet(x => x.Sessions, Times.Never);
    }

    [Theory]
    [InlineData("query")]
    [InlineData("route")]
    [InlineData("etag")]
    [InlineData("weak-etag")]
    public void NativeImageMarkersResolveAcrossSupportedCarriersWithoutSessions(string carrier)
    {
        var context = Context();
        var tag = "abcdef-jeu" + _markers.MintMarker(_bob);
        if (carrier == "query") context.Request.QueryString = new QueryString("?tag=" + tag);
        if (carrier == "route") context.Request.RouteValues["tag"] = tag;
        if (carrier == "etag") context.Request.Headers.IfNoneMatch = "\"" + tag + "\", \"another\"";
        if (carrier == "weak-etag") context.Request.Headers.IfNoneMatch = "W/\"" + tag + "\"";
        var result = _identity.Resolve(context);
        Assert.Equal(IdentityConfidence.Marker, result.Confidence);
        Assert.Equal(new[] { _bob }, result.Candidates);
        _sessions.VerifyGet(x => x.Sessions, Times.Never);
    }

    [Fact]
    public void SharedIpRetainsAllDistinctUsersAndCookieOnlySelectsPresentUser()
    {
        _sessions.SetupGet(x => x.Sessions).Returns(new[] { Session(_alice), Session(_alice), Session(_bob), Session(Guid.Empty), Session(Guid.NewGuid(), "192.0.2.1:8096") });
        var context = Context();
        var result = _identity.Resolve(context);
        Assert.Equal(IdentityConfidence.SharedIpCandidates, result.Confidence);
        Assert.Equal(new[] { _alice, _bob }.Order(), result.Candidates.Order());
        context.Request.Headers.Cookie = "je-spoiler-uid=" + _bob;
        Assert.Equal(new[] { _bob }, _identity.Resolve(context).Candidates);
        Assert.Equal(IdentityConfidence.Cookie, _identity.Resolve(context).Confidence);
        context.Request.Headers.Cookie = "je-spoiler-uid=" + Guid.NewGuid();
        Assert.Equal(new[] { _alice, _bob }.Order(), _identity.Resolve(context).Candidates.Order());
    }

    [Fact]
    public void FreshLoginCookieRefreshesCachedSessionScan()
    {
        var sessions = new List<SessionInfo> { Session(_alice) };
        _sessions.SetupGet(x => x.Sessions).Returns(() => sessions);
        var context = Context();
        Assert.Equal(new[] { _alice }, _identity.Resolve(context).Candidates);
        sessions.Add(Session(_bob));
        context.Request.Headers.Cookie = "je-spoiler-uid=" + _bob;
        var result = _identity.Resolve(context);
        Assert.Equal(IdentityConfidence.Cookie, result.Confidence);
        Assert.Equal(new[] { _bob }, result.Candidates);
        _sessions.VerifyGet(x => x.Sessions, Times.Exactly(2));
    }

    [Fact]
    public void RepeatedForgedCookieDoesNotCauseSessionScanStorm()
    {
        _sessions.SetupGet(x => x.Sessions).Returns(new[] { Session(_alice) });
        var context = Context();
        context.Request.Headers.Cookie = "je-spoiler-uid=" + Guid.NewGuid();
        for (var i = 0; i < 20; i++) Assert.Equal(new[] { _alice }, _identity.Resolve(context).Candidates);
        _sessions.VerifyGet(x => x.Sessions, Times.Exactly(2));
    }

    [Fact]
    public void TopologyInvalidationRemovesSingleUserShortcutImmediately()
    {
        SetUsers(_alice);
        var context = Context();
        Assert.Equal(IdentityConfidence.SingleUserServer, _identity.Resolve(context).Confidence);
        SetUsers(_alice, _bob);
        _identity.InvalidateUserTopology();
        Assert.Equal(IdentityConfidence.None, _identity.Resolve(context).Confidence);
    }

    [Fact]
    public void DeletedUserMarkerStopsResolvingAfterTopologyInvalidation()
    {
        var marker = _markers.MintMarker(_bob);
        Assert.True(_markers.TryResolveMarker(marker, out var resolved)); Assert.Equal(_bob, resolved);
        SetUsers(_alice);
        _markers.InvalidateMap();
        Assert.False(_markers.TryResolveMarker(marker, out _));
    }

    [Fact]
    public void SessionFailuresAndMalformedRowsDoNotInventAnIdentity()
    {
        _sessions.SetupGet(x => x.Sessions).Throws(new InvalidOperationException("concurrent enumeration"));
        Assert.Equal(IdentityConfidence.None, _identity.Resolve(Context()).Confidence);
    }

    [Fact]
    public void MappedIpv6AndInvalidRowsPreserveHealthySessionMatches()
    {
        _sessions.SetupGet(x => x.Sessions).Returns(new[] { Session(_bob, "invalid endpoint"), Session(_alice, "[::ffff:" + _ip + "]:8096") });
        Assert.Equal(new[] { _alice }, _identity.Resolve(Context()).Candidates);
    }

    [Fact]
    public void MarkersAreStableAndUserSpecific()
    {
        Assert.Matches("^[a-f0-9]{12}$", _markers.MintMarker(_alice));
        Assert.Equal(_markers.MintMarker(_alice), _markers.MintMarker(_alice));
        Assert.NotEqual(_markers.MintMarker(_alice), _markers.MintMarker(_bob));
    }

    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData("-jeu123456789abc")]
    [InlineData("abc-jeu123456789ab")] [InlineData("abc-jeu123456789ABC")]
    [InlineData("abc-jeu123456789abc-extra")]
    public void MalformedMarkersCannotResolveAsValidSuffix(string? tag)
        => Assert.False(SpoilerIdentityService.TryParseMarker(tag, out _, out _));

    public void Dispose() => Directory.Delete(_directory, true);
}
