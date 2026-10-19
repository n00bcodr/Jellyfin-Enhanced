using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using User = Jellyfin.Database.Implementations.Entities.User;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

/// <summary>
/// The one surface registry against the hosts' real endpoints (tests/fixtures/host-endpoints) and the model's own
/// independent classification.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacySurfaceRegistryTests
{
    private static string Key(PrivacySurface e) => e.Controller + "." + e.Action;

    [Fact]
    public void EveryTitleCarryingEndpointOfBothHostsIsClassified()
    {
        var registered = PrivacySurfaceRegistry.Entries.Select(Key).ToHashSet();
        foreach (var host in new[] { "12.2", "10.11.11" })
        {
            var missing = PrivacySurfaceModelTests.HostEndpoints.Where(e => e.Host == host && e.TitlePath.Length > 0)
                .Select(e => e.Controller + "." + e.Action).Where(k => !registered.Contains(k)).ToArray();
            Assert.True(missing.Length == 0, host + " unclassified: " + string.Join(", ", missing));
        }
    }

    [Fact]
    public void TheRegistryListsOnlyRealEndpoints()
    {
        var host = PrivacySurfaceModelTests.TitleEndpoints.Keys.ToHashSet();
        var extra = PrivacySurfaceRegistry.Entries.Select(Key).Where(k => !host.Contains(k) && k != "HomeScreen.GetSectionContent").ToArray();
        Assert.True(extra.Length == 0, "not a title endpoint of either host: " + string.Join(", ", extra));
        Assert.Equal(PrivacySurfaceRegistry.Entries.Count, PrivacySurfaceRegistry.Entries.Select(Key).Distinct().Count());
    }

    [Fact]
    public void TheRegistryAgreesWithTheModelsIndependentClassification()
    {
        foreach (var entry in PrivacySurfaceRegistry.Entries)
        {
            var (hc, sg) = PrivacySurfaceModelTests.Expected(Key(entry));
            Assert.True((entry.Hc is "items" or "home-sections" ? "library" : entry.Hc) == hc && entry.Sg == sg, Key(entry));
            Assert.True(entry.Hc != null || !string.IsNullOrEmpty(entry.HcExempt), Key(entry) + " needs a Hidden Content exemption reason");
            Assert.True(entry.Sg || !string.IsNullOrEmpty(entry.SgExempt), Key(entry) + " needs a Spoiler Guard exemption reason");
        }
    }

    /// <summary>Every BaseItemDto reachable in a value's object graph (its own items and any member nesting one).</summary>
    private static List<BaseItemDto> Reachable(object? value)
    {
        var found = new List<BaseItemDto>();
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        void Walk(object? node, int depth)
        {
            if (node == null || depth > 8 || node is string || node.GetType().IsPrimitive || node.GetType().IsEnum || !seen.Add(node)) return;
            if (node is BaseItemDto dto) found.Add(dto);
            if (node is System.Collections.IEnumerable list && node is not System.Collections.IDictionary)
            {
                foreach (var child in list) Walk(child, depth + 1);
                return;
            }
            if (node.GetType().Namespace?.StartsWith("System", StringComparison.Ordinal) == true) return;
            foreach (var property in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0))
                Walk(property.GetValue(node), depth + 1);
        }
        Walk(value, 0);
        return found;
    }

    private static readonly HashSet<Jellyfin.Data.Enums.BaseItemKind> NotTitles =
    [
        BaseItemKind.CollectionFolder, BaseItemKind.UserView, BaseItemKind.Folder, BaseItemKind.AggregateFolder, BaseItemKind.UserRootFolder,
        BaseItemKind.ManualPlaylistsFolder, BaseItemKind.PlaylistsFolder, BaseItemKind.Channel, BaseItemKind.TvChannel, BaseItemKind.Genre,
        BaseItemKind.Person, BaseItemKind.Studio, BaseItemKind.MusicArtist, BaseItemKind.MusicGenre, BaseItemKind.Year,
    ];

    /// <summary>
    /// Rule 1 of round 17: an exemption is proven by what the host actually answers. For every captured answer of an
    /// endpoint whose own items are exempt from Hidden Content, each item it lists is the opened item (or that item's own
    /// extra, part or ancestor) or not a title at all (folders, channels, names); every OTHER title reachable anywhere in
    /// the answer is a nested member the projection walks (so it is projected with the viewer's policy).
    /// </summary>
    [Fact]
    public void EveryExemptionIsProvenByTheHostsCapturedPayload()
    {
        var data = PrivacyHostShapeModelTests.Data;
        var owned = data.Owners.SelectMany(o => data.Roles.Where(r => r.Key.StartsWith("extra:" + o.Key + ":", StringComparison.Ordinal))
            .Select(r => (Item: Guid.Parse(r.Value), Owner: Guid.Parse(o.Value)))).ToDictionary(x => x.Item, x => x.Owner);
        var family = new Dictionary<Guid, Guid>
        {
            [Guid.Parse(data.Roles["season:show-s1"])] = Guid.Parse(data.Roles["series:show"]),
            [Guid.Parse(data.Roles["episode:show-e1"])] = Guid.Parse(data.Roles["series:show"]),
            [Guid.Parse(data.Roles["episode:show-e2"])] = Guid.Parse(data.Roles["series:show"]),
        };
        var checkedEndpoints = new HashSet<string>();
        foreach (var shot in data.Shots.Where(s => !s.Socket))
        {
            var entry = PrivacySurfaceRegistry.Entries.Single(e => Key(e) == shot.Endpoint);
            var value = PrivacyHostShapeModelTests.Value(shot);
            var nested = NativePrivacyProjection.Nested(value).Select(n => n.Dto).ToHashSet(ReferenceEqualityComparer.Instance);
            var reachable = Reachable(value);
            var top = reachable.Where(d => !nested.Contains(d)).ToList();
            // Nothing else nests a title: every reachable DTO is a listed item or a member the projection walks.
            var listed = value switch
            {
                AllThemeMediaResult all => NativePrivacyProjection.ThemeItems(all).Cast<object>(),
                IEnumerable<RecommendationDto> categories => categories.SelectMany(c => c.Items ?? []).Cast<object>(),
                _ => NativePrivacyProjection.Items(value).Cast<object>()
            };
            var listedSet = listed.ToHashSet(ReferenceEqualityComparer.Instance);
            Assert.True(top.All(d => listedSet.Contains(d)), shot.File + ": a title nested where the projection does not walk");
            if (entry.Hc != null) continue;
            checkedEndpoints.Add(shot.Endpoint);
            var opened = PrivacyHostShapeModelTests.Opened(shot);
            foreach (var dto in top)
            {
                // The title an item belongs to: an extra's owner, a season's or episode's series, else itself.
                Guid Title(Guid id) => owned.TryGetValue(id, out var owner) ? Title(owner) : family.TryGetValue(id, out var series) ? series : id;
                var ofOpened = opened is { } o && Title(dto.Id) == Title(o);
                Assert.True(ofOpened || NotTitles.Contains(dto.Type), $"{shot.File}: {dto.Type} {dto.Name} is neither the opened item's nor a non-title");
            }
            if (value is MediaBrowser.Controller.Authentication.AuthenticationResult signIn) Assert.Null(signIn.SessionInfo?.NowPlayingItem);
        }
        // The captured exempt families: opened items, extras, themes, images, playback, folders, names, channels, sessions, timers, sign-in.
        foreach (var endpoint in new[] { "UserLibrary.GetItem", "Library.GetAncestors", "UserLibrary.GetLocalTrailers", "UserLibrary.GetSpecialFeatures",
            "Library.GetThemeSongs", "Library.GetThemeMedia", "Image.GetItemImageInfos", "MediaInfo.GetPlaybackInfo", "UserViews.GetUserViews",
            "Library.GetMediaFolders", "Genres.GetGenres", "Persons.GetPersons", "LiveTv.GetLiveTvChannels", "LiveTv.GetChannel", "Session.GetSessions",
            "LiveTv.GetTimers", "LiveTv.GetSeriesTimers", "User.AuthenticateUserByName", "ActivityLog.GetLogEntries" })
            Assert.Contains(endpoint, checkedEndpoints);
    }

    [Theory]
    [InlineData(typeof(QueryResult<BaseItemDto>), true)]
    [InlineData(typeof(List<RecommendationDto>), true)]
    [InlineData(typeof(SearchHintResult), true)]
    [InlineData(typeof(PlaybackInfoResponse), true)]
    [InlineData(typeof(List<ImageInfo>), true)]
    [InlineData(typeof(AllThemeMediaResult), true)]
    [InlineData(typeof(List<SessionInfoDto>), true)]
    [InlineData(typeof(UserItemDataDto), false)]
    [InlineData(typeof(QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>), true)]
    [InlineData(typeof(string), false)]
    public void TheRuntimeTitleWalkMatchesTheHostExtraction(Type type, bool carries)
        => Assert.Equal(carries, PrivacySurfaceRegistry.CarriesTitles(type));
}
