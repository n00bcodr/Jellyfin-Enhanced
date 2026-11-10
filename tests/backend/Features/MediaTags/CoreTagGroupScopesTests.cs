using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace JE.Tests.Features.MediaTags;

/// <summary>
/// "Where to show" for every card tag group (TagGroupScopes): personal switches over the administrator's
/// defaults over "on", the native resolver's item-type gate, settings digests and the page/portable contracts.
/// </summary>
public class CoreTagGroupScopesTests
{
    private static TagCacheEntry Movie() => new() { Type = "Movie", Genres = ["Drama"], OfficialRating = "PG-13", CommunityRating = 7.5f };

    private static IEnumerable<PosterTagGroup> Groups(PosterTagSettings settings, string type)
    {
        var entry = Movie();
        entry.Type = type;
        return PosterTagResolver.Resolve(entry, settings, new(type, false, null, null, null), false)?.Groups.Select(g => g.Group) ?? [];
    }

    private static JellyfinEnhancedUserSettings User(TagGroupScopes? scopes = null) => new()
    {
        TagLayoutSettingsVersion = 1, GenreTagsEnabled = true, AgeRatingTagsEnabled = true, RatingTagsEnabled = true, TagGroupScopes = scopes,
    };

    [Fact]
    public void UnsetScopesShowEveryGroupEverywhereAndKeepTheDigest()
    {
        var config = new PluginConfiguration();
        var plain = PosterTagSettings.FromUserSettings(User(), config);
        var emptySet = PosterTagSettings.FromUserSettings(User(new TagGroupScopes { Genre = new TagScopeSet() }), config);
        var allOn = PosterTagSettings.FromUserSettings(User(new TagGroupScopes { Genre = new TagScopeSet { Episodes = true } }), config);
        foreach (var type in new[] { "Movie", "Series", "Season", "Episode", "BoxSet" })
            Assert.Contains(PosterTagGroup.Genre, Groups(plain, type));
        Assert.Equal(plain.Digest, emptySet.Digest);
        Assert.Equal(plain.Digest, allOn.Digest);
        Assert.Null(TagLayoutRules.NormalizeScopes(new TagGroupScopes { Genre = new TagScopeSet(), Quality = null }));
    }

    [Fact]
    public void PersonalSwitchesWinOverTheAdministratorsWhichWinOverOn()
    {
        var config = new PluginConfiguration { TagGroupScopes = new TagGroupScopes { Genre = new TagScopeSet { Episodes = false }, AgeRating = new TagScopeSet { Movies = false } } };
        var following = PosterTagSettings.FromUserSettings(User(), config);
        Assert.DoesNotContain(PosterTagGroup.Genre, Groups(following, "Episode"));
        Assert.Contains(PosterTagGroup.Genre, Groups(following, "Movie"));
        Assert.DoesNotContain(PosterTagGroup.AgeRating, Groups(following, "Movie"));
        var own = PosterTagSettings.FromUserSettings(User(new TagGroupScopes { Genre = new TagScopeSet { Episodes = true, Series = false } }), config);
        Assert.Contains(PosterTagGroup.Genre, Groups(own, "Episode"));
        Assert.DoesNotContain(PosterTagGroup.Genre, Groups(own, "Series"));
        // Types no switch governs (a collection) always show; the home rows do not reach an image request.
        var rows = PosterTagSettings.FromUserSettings(User(new TagGroupScopes { Genre = new TagScopeSet { ContinueWatching = false, NextUp = false } }), new PluginConfiguration());
        Assert.Contains(PosterTagGroup.Genre, Groups(rows, "BoxSet"));
        Assert.Contains(PosterTagGroup.Genre, Groups(rows, "Episode"));
        Assert.Equal(PosterTagSettings.FromUserSettings(User(), new PluginConfiguration()).Digest, rows.Digest);
        // Every scoped group follows the same rule; Rating keeps its own switches.
        foreach (var group in TagLayoutRules.ScopedGroups)
        {
            var scopes = new TagGroupScopes();
            typeof(TagGroupScopes).GetProperty(char.ToUpperInvariant(group[0]) + group[1..])!.SetValue(scopes, new TagScopeSet { Seasons = false });
            Assert.False(TagLayoutRules.ScopeAllows(scopes, null, group, "seasons"), group);
            Assert.True(TagLayoutRules.ScopeAllows(scopes, null, group, "movies"), group);
        }
        Assert.True(TagLayoutRules.ScopeAllows(null, null, "rating", "seasons"));
        Assert.True(TagLayoutRules.ScopeAllows(null, null, "people", "seasons"));
    }

    [Fact]
    public void AScopeThatHidesAGroupChangesTheDigestSoPosterUrlsRetire()
    {
        var config = new PluginConfiguration();
        var before = PosterTagSettings.FromUserSettings(User(), config).Digest;
        var after = PosterTagSettings.FromUserSettings(User(new TagGroupScopes { Genre = new TagScopeSet { Movies = false } }), config).Digest;
        var admin = PosterTagSettings.FromUserSettings(User(), new PluginConfiguration { TagGroupScopes = new TagGroupScopes { Genre = new TagScopeSet { Movies = false } } }).Digest;
        Assert.NotEqual(before, after);
        Assert.Equal(after, admin);
    }

    [Fact]
    public void ScopesRoundTripThroughTheUserDocumentAndTheServerConfiguration()
    {
        var user = User(new TagGroupScopes { Logos = new TagScopeSet { NextUp = false, Movies = true } });
        TagLayoutRules.Normalize(user);
        var restored = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(JsonSerializer.Serialize(user))!;
        Assert.Equal((false, true), (restored.TagGroupScopes!.Logos!.NextUp, restored.TagGroupScopes.Logos.Movies));
        var config = new PluginConfiguration { TagGroupScopes = new TagGroupScopes { Status = new TagScopeSet { ContinueWatching = false } } };
        using var writer = new StringWriter();
        new XmlSerializer(typeof(PluginConfiguration)).Serialize(writer, config);
        using var reader = new StringReader(writer.ToString());
        var xml = (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(reader)!;
        Assert.False(xml.TagGroupScopes!.Status!.ContinueWatching);
        Assert.Null(xml.TagGroupScopes.Genre);
    }

    [Fact]
    public void ThePageAndPortableDocumentsCarryTheScopes()
    {
        Assert.Contains("TagGroupScopes", MediaTagsPageFields.Allowed);
        Assert.Contains("TagGroupScopes", MediaTagsPortable.UserFields);
        Assert.True(MediaTagsPageFields.TryNormalize("TagGroupScopes", new TagGroupScopes { Genre = new TagScopeSet() }, out var normalized, out _));
        Assert.Null(normalized);
    }

    [Fact]
    public void RatingFollowsTheAdministratorWhileAnOlderOffStaysTheUsers()
    {
        var config = new PluginConfiguration();
        var user = User();
        user.RatingTagsOnSeries = false;
        Assert.True(TagLayoutRules.RatingScope(user, config, "movies"));
        Assert.False(TagLayoutRules.RatingScope(user, config, "series"));
        config.RatingTagsOnMovies = false;
        Assert.False(TagLayoutRules.RatingScope(user, config, "movies"), "an older on follows a later administrator off");
        Assert.False(PosterTagSettings.FromUserSettings(user, config).RatingTagsOnMovies);
        user.TagGroupScopes = new TagGroupScopes { Rating = new TagScopeSet { Movies = true, Series = true } };
        Assert.True(TagLayoutRules.RatingScope(user, config, "movies"), "the user's own switch wins");
        Assert.True(TagLayoutRules.RatingScope(user, config, "series"));
        Assert.NotNull(TagLayoutRules.NormalizeScopes(new TagGroupScopes { Rating = new TagScopeSet { NextUp = false } })?.Rating);
    }
}
