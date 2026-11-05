using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
namespace JE.Tests;

public class PosterTokenTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "je-poster-tests-" + Guid.NewGuid().ToString("N"));
    private readonly Guid user = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private readonly Guid item = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private PosterTagVariantToken Tokens() => PosterTagVariantToken.CreateForPath(Path.Combine(directory, "secret"), _ => { });

    [Fact]
    public void ImagesFromBeforeMixedHadANativeColourCannotReuseTheCurrentPixelToken()
    {
        var service = Tokens();
        var old = service.Mint(user, item, "mixed-settings", "1.1", PosterTagVariantFlags.None, "abcdef");
        var current = service.Mint(user, item, "mixed-settings", PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.NotEqual(old, current);
        Assert.False(service.Verify(old, user, item, "mixed-settings", PosterTagComposer.PixelVersion, out _));
        Assert.True(service.Verify(current, user, item, "mixed-settings", PosterTagComposer.PixelVersion, out _));
    }

    [Fact]
    public void AudioResolverTenToElevenRetiresTokensAtTheSamePixelIdentity()
    {
        // Same subtitle-only document and defaults, resolver 10 then 11, both at pixel 7.1.
        // Only resolver.version changes in this document's canonical digest.
        const string version10Digest = "5c28225fcda7dccf";
        const string version11Digest = "223695b6d0444ff8";
        var settings = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsShowSubtitles\":true,\"LanguageTagsStyle\":\"codes\"}", new());
        Assert.Equal("38", PosterTagSettings.ResolverVersion);
        Assert.Equal("8.6", PosterTagComposer.PixelVersion);
        var service = Tokens();
        var old = service.Mint(user, item, version10Digest, "7.1", PosterTagVariantFlags.None, "abcdef");
        var version11 = service.Mint(user, item, version11Digest, "7.1", PosterTagVariantFlags.None, "abcdef");
        Assert.NotEqual(old, version11);
        Assert.False(service.Verify(old, user, item, version11Digest, "7.1", out _));
        Assert.True(service.Verify(version11, user, item, version11Digest, "7.1", out _));
        Assert.False(service.Verify(old, user, item, settings.Digest, "7.1", out _));
        Assert.False(service.Verify(version11, user, item, settings.Digest, "7.1", out _));
        var current = service.Mint(user, item, settings.Digest, "7.1", PosterTagVariantFlags.None, "abcdef");
        Assert.True(service.Verify(current, user, item, settings.Digest, "7.1", out _));
    }

    [Fact]
    public void TextLogoMetricsRetireAlreadyFittedPixelTokens()
    {
        var service = Tokens();
        Assert.Equal("8.6", PosterTagComposer.PixelVersion);
        var old = service.Mint(user, item, "logo-side-settings", "8.1", PosterTagVariantFlags.None, "abcdef");
        Assert.False(service.Verify(old, user, item, "logo-side-settings", PosterTagComposer.PixelVersion, out _));
        var current = service.Mint(user, item, "logo-side-settings", PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.True(service.Verify(current, user, item, "logo-side-settings", PosterTagComposer.PixelVersion, out _));
    }

    [Fact]
    public void CompactCornersRetireFullLabelPixelTokens()
    {
        var service = Tokens();
        var old = service.Mint(user, item, "compact-corners", "8.2", PosterTagVariantFlags.None, "abcdef");
        Assert.Equal("8.6", PosterTagComposer.PixelVersion);
        Assert.False(service.Verify(old, user, item, "compact-corners", PosterTagComposer.PixelVersion, out _));
        var current = service.Mint(user, item, "compact-corners", PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.True(service.Verify(current, user, item, "compact-corners", PosterTagComposer.PixelVersion, out _));
    }

    [Fact]
    public void SharedLanguageChipPixelsRetireOutlinedChipTokens()
    {
        var service = Tokens();
        Assert.Equal("8.6", PosterTagComposer.PixelVersion);
        var old = service.Mint(user, item, "language-chips", "8.3", PosterTagVariantFlags.None, "abcdef");
        Assert.False(service.Verify(old, user, item, "language-chips", PosterTagComposer.PixelVersion, out _));
        var current = service.Mint(user, item, "language-chips", PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.True(service.Verify(current, user, item, "language-chips", PosterTagComposer.PixelVersion, out _));
    }

    [Fact]
    public void TightLanguageCodePaddingRetiresWiderChipTokens()
    {
        var service = Tokens();
        var old = service.Mint(user, item, "language-codes", "8.4", PosterTagVariantFlags.None, "abcdef");
        Assert.False(service.Verify(old, user, item, "language-codes", PosterTagComposer.PixelVersion, out _));
    }

    [Theory]
    [InlineData("4.1")]
    [InlineData("5.1")]
    public void TierTwoPixelsRejectTierOneAndRoundOneTokens(string historicalVersion)
    {
        var service = Tokens();
        Assert.Equal("8.6", PosterTagComposer.PixelVersion);
        var old = service.Mint(user, item, "settings", historicalVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.False(service.Verify(old, user, item, "settings", PosterTagComposer.PixelVersion, out _));
    }

    [Theory]
    [InlineData(PosterTagVariantFlags.None)]
    [InlineData(PosterTagVariantFlags.TopRightOffset)]
    [InlineData(PosterTagVariantFlags.SpoilerScoped)]
    [InlineData(PosterTagVariantFlags.TopRightOffset | PosterTagVariantFlags.SpoilerScoped)]
    public void Token_binds_user_item_settings_renderer_and_data(PosterTagVariantFlags flags)
    {
        var service = Tokens();
        var token = service.Mint(user, item, "settings", "renderer", flags, "abcdef");
        Assert.True(service.Verify(token, user, item, "settings", "renderer", out var parsed));
        Assert.Equal(flags, parsed.Flags);
        Assert.Equal("abcdef", parsed.DataHash);
        Assert.False(parsed.IsWeak);
        Assert.False(service.Verify(token, item, item, "settings", "renderer", out _));
        Assert.False(service.Verify(token, user, user, "settings", "renderer", out _));
        Assert.False(service.Verify(token, user, item, "changed", "renderer", out _));
        Assert.False(service.Verify(token, user, item, "settings", "changed", out _));
        for (int i = 0; i < token.Length; i++)
        {
            var tampered = token.ToCharArray();
            tampered[i] = tampered[i] == '0' ? '1' : '0';
            Assert.False(service.Verify(new string(tampered), user, item, "settings", "renderer", out _));
        }
        Assert.True(Tokens().Verify(token, user, item, "settings", "renderer", out _));
    }

    [Fact]
    public void Posters_from_the_category_blind_tile_cache_are_invalidated()
    {
        var service = Tokens();
        var old = service.Mint(user, item, "settings", "2.1", PosterTagVariantFlags.None, "abcdef");
        Assert.False(service.Verify(old, user, item, "settings", PosterTagComposer.PixelVersion, out _));
        var current = service.Mint(user, item, "settings", PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.True(service.Verify(current, user, item, "settings", PosterTagComposer.PixelVersion, out _));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("abcdef")]
    [InlineData("0000000000000000000000G")]
    [InlineData("40000000000000000000000")]
    [InlineData("000000000000000000000000")]
    public void Invalid_token_shapes_are_rejected(string? token) => Assert.False(PosterTagVariantToken.TryParse(token, out _));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("ABCDEF")]
    [InlineData("abcdeg")]
    [InlineData("abcdefg")]
    public void Invalid_data_hashes_cannot_be_minted(string? hash) => Assert.Throws<ArgumentException>(() => Tokens().Mint(user, item, "s", "r", PosterTagVariantFlags.None, hash!));

    [Fact]
    public void Weak_token_is_explicit_and_corrupt_secret_recovers()
    {
        Directory.CreateDirectory(directory);
        File.WriteAllBytes(Path.Combine(directory, "secret"), [1, 2]);
        var warnings = new List<string>();
        var service = PosterTagVariantToken.CreateForPath(Path.Combine(directory, "secret"), warnings.Add);
        var token = service.Mint(user, item, "s", "r", PosterTagVariantFlags.None, PosterTagVariantToken.WeakDataHash);
        Assert.True(service.Verify(token, user, item, "s", "r", out var parsed));
        Assert.True(parsed.IsWeak);
        Assert.Single(warnings);
        Assert.Equal(32, File.ReadAllBytes(Path.Combine(directory, "secret")).Length);
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(directory, "secret")));
        Assert.Empty(Directory.GetFiles(directory, "*.tmp.*"));
    }

    [Fact]
    public void Concurrent_first_use_shares_one_persisted_secret()
    {
        // The loser has already seen no secret file when the winner creates
        // one and mints with it; the loser must adopt it, not overwrite it.
        var winner = Tokens();
        var loser = Tokens();
        string? winnerToken = null;
        loser.BeforeSecretWriteForTest = () => winnerToken = winner.Mint(user, item, "s", "r", PosterTagVariantFlags.None, "123abc");
        var loserToken = loser.Mint(user, item, "s", "r", PosterTagVariantFlags.None, "123abc");
        Assert.NotNull(winnerToken);
        Assert.Equal(winnerToken, loserToken);
        Assert.Equal(winnerToken, Tokens().Mint(user, item, "s", "r", PosterTagVariantFlags.None, "123abc"));
        Assert.Empty(Directory.GetFiles(directory, "*.tmp.*"));
    }

    [Fact]
    public async Task Racing_first_use_after_every_check_shares_one_secret()
    {
        // All instances pass the existence check before any of them writes.
        const int count = 8;
        using var allChecked = new Barrier(count);
        var services = Enumerable.Range(0, count).Select(_ => Tokens()).ToList();
        foreach (var service in services) service.BeforeSecretWriteForTest = () => allChecked.SignalAndWait(TimeSpan.FromSeconds(10));
        var tokens = await Task.WhenAll(services.Select(service => Task.Factory.StartNew(() => service.Mint(user, item, "s", "r", PosterTagVariantFlags.None, "123abc"), TaskCreationOptions.LongRunning)));
        Assert.Single(tokens.Distinct());
        Assert.Equal(tokens[0], Tokens().Mint(user, item, "s", "r", PosterTagVariantFlags.None, "123abc"));
        Assert.Empty(Directory.GetFiles(directory, "*.tmp.*"));
    }

    public void Dispose() { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
}
