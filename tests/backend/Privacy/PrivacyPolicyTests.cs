using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Xunit;

namespace JellyfinEnhanced.Tests;

public class PrivacyPolicyTests
{
    [Theory]
    [InlineData(null, null, true, null, null, false)]
    [InlineData(null, null, false, 0, 0, true)]
    [InlineData(18, 9, true, null, 0, true)]
    [InlineData(12, 0, false, 12, 0, true)]
    [InlineData(13, 0, false, 12, 0, false)]
    [InlineData(6, 1, false, 12, 0, false)]
    [InlineData(12, null, false, 12, 0, true)]
    [InlineData(12, 99, false, 12, null, true)]
    public void RatingCeilingsAndUnratedPolicy(int? score, int? sub, bool blockUnrated, int? max, int? maxSub, bool allowed)
        => Assert.Equal(allowed, ParentalRatingDecision.IsAllowed(score, sub, blockUnrated, max, maxSub));

    [Theory]
    [InlineData("family", "horror", "horror", "family", false)]
    [InlineData("FAMILY", "", "", "family", true)]
    [InlineData("", "family", "", "family", false)]
    [InlineData("family", "", "", "family!", false)]
    [InlineData("cafe", "", "", "café", false)]
    [InlineData("horror comedy", "", "horror", "", true)]
    [InlineData("", "", "", "", true)]
    public void TagsUseWholeValuesBlockedWinsAndGenresCannotGrantAccess(string keyword, string genre, string blocked, string allowed, bool expected)
        => Assert.Equal(expected, ParentalTagDecision.IsAllowed(
            ParentalTagDecision.ToTagSet([keyword]), ParentalTagDecision.ToTagSet([genre]),
            ParentalTagDecision.ToTagSet([blocked]), ParentalTagDecision.ToTagSet([allowed])));

    [Fact]
    public void TagSetsDropBlanksAndDeduplicateWithoutRemovingPunctuation()
    {
        var tags = ParentalTagDecision.ToTagSet([null, "", "  ", " FAMILY! ", "family!", "family"]);
        Assert.Equal(2, tags.Count);
        Assert.Contains("family!", tags);
        Assert.Contains("family", tags);
        Assert.Empty(ParentalTagDecision.ToTagSet(null));
    }

    [Fact]
    public void ExplicitUserSelectionRequiresSelfOrAdministrator()
    {
        var self = Guid.NewGuid();
        var other = Guid.NewGuid();
        var principal = Principal(self);
        Assert.Equal(self, UserHelper.GetUserId(principal, null));
        Assert.Equal(self, UserHelper.GetUserId(principal, Guid.Empty));
        Assert.Equal(self, UserHelper.GetUserId(principal, self));
        Assert.Null(UserHelper.GetUserId(principal, other));
        Assert.Equal(other, UserHelper.GetUserId(Principal(self, true), other));
        Assert.Null(UserHelper.GetUserId(new ClaimsPrincipal(), other));
        Assert.Null(UserHelper.GetCurrentUserId(new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", "invalid")]))));
    }

    internal static ClaimsPrincipal Principal(Guid id, bool admin = false) => new(new ClaimsIdentity(
        new[] { new Claim("Jellyfin-UserId", id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User") }, "Test"));

    [Fact]
    public void PoliciesRequireEnabledFeatureAndNonemptyScope()
    {
        var config = new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = true };
        Assert.Null(SpoilerTagDataStripper.CreatePolicy(null, new UserSpoilerBlur()));
        Assert.Null(SpoilerTagDataStripper.CreatePolicy(config, null));
        Assert.Null(SpoilerTagDataStripper.CreatePolicy(config, new UserSpoilerBlur()));
        var state = new UserSpoilerBlur();
        state.Movies[Guid.NewGuid().ToString("N")] = new();
        Assert.NotNull(SpoilerTagDataStripper.CreatePolicy(config, state));
        config.SpoilerBlurEnabled = false;
        Assert.Null(SpoilerTagDataStripper.CreatePolicy(config, state));
    }

    [Fact]
    public void EveryAdminAndUserPreferenceCombinationRespectsAdminCapAndUserOptOut()
    {
        // Four independent categories: enumerate all admin masks and nullable user choices.
        for (var admin = 0; admin < 16; admin++)
        for (var prefs = 0; prefs < 81; prefs++)
        {
            bool?[] choices = new bool?[4];
            var remaining = prefs;
            for (var i = 0; i < 4; i++) { choices[i] = (remaining % 3) switch { 0 => null, 1 => false, _ => true }; remaining /= 3; }
            var config = new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = (admin & 1) != 0,
                SpoilerStripRatings = (admin & 2) != 0, SpoilerReplaceTitle = (admin & 4) != 0, SpoilerStripOverview = (admin & 8) != 0 };
            var state = new UserSpoilerBlur { Prefs = new SpoilerBlurUserPrefs { HideTags = choices[0], HideRatings = choices[1],
                ReplaceEpisodeTitles = choices[2], HideEpisodeDescriptions = choices[3] } };
            state.Collections[Guid.NewGuid().ToString("N")] = new();
            var expected = Enumerable.Range(0, 4).Select(i => (admin & (1 << i)) != 0 && choices[i] != false).ToArray();
            var policy = SpoilerTagDataStripper.CreatePolicy(config, state);
            if (!expected.Any(x => x)) Assert.Null(policy);
            else { Assert.NotNull(policy); Assert.Equal(expected, new[] { policy.StripGenres, policy.StripRatings, policy.ReplaceTitle, policy.StripOverview });
                Assert.Equal(expected[2] || expected[3], policy.SanitizeTitleStreams); }
        }
    }

    [Theory]
    [InlineData("{}")] // pre-movie/collection versions
    [InlineData("{\"Series\":null,\"Movies\":null,\"Collections\":null}")]
    public void LegacyAndNullSpoilerScopesDeserializeSafely(string json)
    {
        var state = System.Text.Json.JsonSerializer.Deserialize<UserSpoilerBlur>(json)!;
        Assert.Empty(state.Series); Assert.Empty(state.Movies); Assert.Empty(state.Collections);
    }

    [Fact]
    public void DeserializedSpoilerScopesRemainCaseInsensitive()
    {
        var state = System.Text.Json.JsonSerializer.Deserialize<UserSpoilerBlur>("{\"Series\":{\"ABCDEF\":{}},\"Movies\":{\"ABCDEF\":{}},\"Collections\":{\"ABCDEF\":{}}}")!;
        Assert.True(state.Series.ContainsKey("abcdef")); Assert.True(state.Movies.ContainsKey("abcdef")); Assert.True(state.Collections.ContainsKey("abcdef"));
    }
}
