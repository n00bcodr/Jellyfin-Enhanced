using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
namespace JE.Tests;

public class PosterTokenTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "je-poster-tests-" + Guid.NewGuid().ToString("N"));
    private readonly Guid user = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private readonly Guid item = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private PosterTagVariantToken Tokens() => PosterTagVariantToken.CreateForPath(Path.Combine(directory, "secret"), _ => { });

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
    public async Task Concurrent_first_use_shares_one_persisted_secret()
    {
        var tokens = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => Task.Run(() => Tokens().Mint(user, item, "s", "r", PosterTagVariantFlags.None, "123abc"))));
        Assert.Single(tokens.Distinct());
        Assert.Empty(Directory.GetFiles(directory, "*.tmp.*"));
    }

    public void Dispose() { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
}
