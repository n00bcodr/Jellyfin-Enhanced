using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;

namespace JE.Tests;

// Stage 1 fix round 4 (RBS1-R4-1): the display-language gate of a document JE puts in place without writing it itself (a JE
// backup restore, the start-up folder migration) is LOSSLESS and FAILS CLOSED. It replaces only the value of the
// document's own DisplayLanguage key(s) at their token offsets; every other byte stays (numbers outside double or decimal
// range, 28+ digit decimals, a BOM, comments, escapes, whitespace). A document the gate can't read is never restored as
// it is: the restore refuses that file and says so.
[Collection("Plugin singleton")]
public class ApiSettingsGateTests
{
    private const string User = "0123456789abcdef0123456789abcdef";
    private const string Other = "fedcba9876543210fedcba9876543210";
    private static readonly byte[] Bom = { 0xEF, 0xBB, 0xBF };

    private static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    /// <summary>A document as stored, and what the gate must leave: the same bytes but the top-level language value(s).</summary>
    public static IEnumerable<object[]> Lossless()
    {
        static object[] Row(string name, string stored, string gated, bool bom = false)
            => new object[] { name, bom ? Bom.Concat(Utf8(stored)).ToArray() : Utf8(stored), bom ? Bom.Concat(Utf8(gated)).ToArray() : Utf8(gated) };

        const string Numbers = "\"FutureRatio\": 1e-40,\n  \"Huge\": 1e40,\n  \"Beyond\": 1E+400,\n  \"Precise\": 0.1234567890123456789012345678901,\n"
            + "  \"Long\": 1234567890123456789012345678901234567890,\n  \"Negative\": -0.0,\n  \"Ratio\": 1.10,\n  \"Note\": \"2026-10-19T10:00:00Z\"";
        return new[]
        {
            Row("extreme numbers", "{\n  \"DisplayLanguage\": \"ja\",\n  " + Numbers + "\n}", "{\n  \"DisplayLanguage\": \"\",\n  " + Numbers + "\n}"),
            Row("canonical case", "{\"Ratio\":1e-40,\"DisplayLanguage\":\"pt-br\",\"Huge\":1e40}", "{\"Ratio\":1e-40,\"DisplayLanguage\":\"pt-BR\",\"Huge\":1e40}"),
            Row("crlf, tabs, spaces", "{\r\n\t\"Ratio\" : 1.10 ,\r\n\t\"DisplayLanguage\" :\t\"en-US-US\" ,\r\n\t\"X\":[ 1 , 2 ]\r\n}",
                "{\r\n\t\"Ratio\" : 1.10 ,\r\n\t\"DisplayLanguage\" :\t\"\" ,\r\n\t\"X\":[ 1 , 2 ]\r\n}"),
            Row("duplicate keys", "{\"DisplayLanguage\":\"fr\",\"Ratio\":1e-40,\"DisplayLanguage\":\"ja\"}", "{\"DisplayLanguage\":\"fr\",\"Ratio\":1e-40,\"DisplayLanguage\":\"\"}"),
            Row("duplicate keys, both changed", "{\"DisplayLanguage\":\"ja\",\"DisplayLanguage\":\"pt-br\"}", "{\"DisplayLanguage\":\"\",\"DisplayLanguage\":\"pt-BR\"}"),
            Row("escaped key spelling", "{\"Display\\u004Canguage\":\"ja\",\"Huge\":1e40}", "{\"Display\\u004Canguage\":\"\",\"Huge\":1e40}"),
            Row("key in another case", "{\"displaylanguage\":\"haw-AU\",\"Huge\":1e40}", "{\"displaylanguage\":\"\",\"Huge\":1e40}"),
            Row("escaped value", "{\"DisplayLanguage\":\"j\\u0061\",\"Huge\":1e40}", "{\"DisplayLanguage\":\"\",\"Huge\":1e40}"),
            Row("byte-order mark", "{\"DisplayLanguage\":\"ja\",\"FutureRatio\":1e-40}", "{\"DisplayLanguage\":\"\",\"FutureRatio\":1e-40}", bom: true),
            Row("nested look-alikes", "{\"Nested\":{\"DisplayLanguage\":\"ja\"},\"List\":[{\"DisplayLanguage\":\"ja\"}],\"Text\":\"\\\"DisplayLanguage\\\":\\\"ja\\\"\",\"DisplayLanguage\":\"ja\"}",
                "{\"Nested\":{\"DisplayLanguage\":\"ja\"},\"List\":[{\"DisplayLanguage\":\"ja\"}],\"Text\":\"\\\"DisplayLanguage\\\":\\\"ja\\\"\",\"DisplayLanguage\":\"\"}"),
            Row("an object value", "{\"DisplayLanguage\":{\"x\":\"ja\",\"y\":[1e40]},\"Ratio\":1e-40}", "{\"DisplayLanguage\":\"\",\"Ratio\":1e-40}"),
            Row("a number value", "{\"DisplayLanguage\":5,\"Ratio\":1e-40}", "{\"DisplayLanguage\":\"\",\"Ratio\":1e-40}"),
            Row("an array value", "{\"DisplayLanguage\":[\"ja\"],\"Ratio\":1e-40}", "{\"DisplayLanguage\":\"\",\"Ratio\":1e-40}"),
            Row("comments and a trailing comma", "{/* older */\"DisplayLanguage\":\"ja\", // note\n\"Ratio\":1e-40,}", "{/* older */\"DisplayLanguage\":\"\", // note\n\"Ratio\":1e-40,}"),
            Row("other text", "{\"Name\":\"日本語 😀\",\"DisplayLanguage\":\"ja\",\"Huge\":1e40}", "{\"Name\":\"日本語 😀\",\"DisplayLanguage\":\"\",\"Huge\":1e40}"),
            Row("accepted: unchanged", "{\"DisplayLanguage\":\"en-AU\",\"Huge\":1e40,\"Beyond\":1E+400}", "{\"DisplayLanguage\":\"en-AU\",\"Huge\":1e40,\"Beyond\":1E+400}"),
            Row("accepted escaped: unchanged", "{\"DisplayLanguage\":\"en\\u002DAU\",\"Huge\":1e40}", "{\"DisplayLanguage\":\"en\\u002DAU\",\"Huge\":1e40}"),
            Row("null: unchanged (reads as Auto)", "{\"DisplayLanguage\":null,\"Huge\":1e40}", "{\"DisplayLanguage\":null,\"Huge\":1e40}"),
            Row("no language: unchanged", "{\"Huge\":1e40,\"Precise\":0.1234567890123456789012345678901}", "{\"Huge\":1e40,\"Precise\":0.1234567890123456789012345678901}"),
        };
    }

    /// <summary>Documents no gate can read: never restored as they are.</summary>
    public static IEnumerable<object[]> Unreadable()
    {
        var deep = "{\"DisplayLanguage\":\"ja\",\"Deep\":" + string.Concat(Enumerable.Repeat("[", 100)) + string.Concat(Enumerable.Repeat("]", 100)) + "}";
        return new[]
        {
            new object[] { "truncated", Utf8("{\"DisplayLanguage\":\"ja\",") },
            new object[] { "a second value after the document", Utf8("{\"DisplayLanguage\":\"ja\"} {}") },
            new object[] { "single quotes", Utf8("{'DisplayLanguage':'ja'}") },
            new object[] { "an unquoted key", Utf8("{DisplayLanguage:\"ja\"}") },
            new object[] { "NaN", Utf8("{\"DisplayLanguage\":\"ja\",\"Ratio\":NaN}") },
            new object[] { "an array document", Utf8("[{\"DisplayLanguage\":\"ja\"}]") },
            new object[] { "a string document", Utf8("\"ja\"") },
            new object[] { "a null document", Utf8("null") },
            new object[] { "empty", Array.Empty<byte>() },
            new object[] { "invalid UTF-8", Utf8("{\"DisplayLanguage\":\"ja\",\"Name\":\"").Concat(new byte[] { 0xFF, 0xFE }).Concat(Utf8("\"}")).ToArray() },
            new object[] { "UTF-16", new byte[] { 0xFF, 0xFE }.Concat(Encoding.Unicode.GetBytes("{\"DisplayLanguage\":\"ja\"}")).ToArray() },
            new object[] { "nested past the reader's depth", Utf8(deep) },
        };
    }

    private sealed class Restored
    {
        public byte[] User { get; init; } = Array.Empty<byte>();
        public byte[] Other { get; init; } = Array.Empty<byte>();
        public JsonElement Result { get; init; }
    }

    // A backup holding the person's settings.json as given (and another person's, readable), restored after both changed.
    private static Restored Restore(byte[] inBackup)
    {
        using var f = new ApiPluginFixture();
        var configPath = Path.Combine(f.Core.Root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);
        using (var s = File.Create(configPath)) new XmlSerializer(typeof(PluginConfiguration)).Serialize(s, f.Plugin.Configuration);
        var user = Path.Combine(Directory.CreateDirectory(Path.Combine(f.Core.ConfigRoot, User)).FullName, "settings.json");
        var other = Path.Combine(Directory.CreateDirectory(Path.Combine(f.Core.ConfigRoot, Other)).FullName, "settings.json");
        File.WriteAllBytes(user, inBackup);
        File.WriteAllText(other, "{\"DisplayLanguage\":\"de\",\"Huge\":1e40}");
        var service = new JeBackupService(f.Core.ConfigRoot, configPath, () => f.Plugin.Secrets, f.Core.Logger);
        using var zip = new MemoryStream();
        service.Export(zip, JeBackupSecrets.Exclude, null);
        File.WriteAllText(user, "{\"DisplayLanguage\":\"fr\"}");
        File.WriteAllText(other, "{}");
        var result = service.Restore(new MemoryStream(zip.ToArray()), null);
        return new Restored { User = File.ReadAllBytes(user), Other = File.ReadAllBytes(other), Result = JsonSerializer.SerializeToElement(result) };
    }

    [Theory]
    [MemberData(nameof(Lossless))]
    public void ABackupRestoreChangesOnlyTheDisplayLanguageBytes(string name, byte[] stored, byte[] gated)
    {
        var restored = Restore(stored);
        Assert.True(gated.SequenceEqual(restored.User), $"{name}: stored {Encoding.UTF8.GetString(restored.User)}, expected {Encoding.UTF8.GetString(gated)}");
        Assert.Equal(Hash(gated), Hash(restored.User));
        Assert.Equal("{\"DisplayLanguage\":\"de\",\"Huge\":1e40}", Encoding.UTF8.GetString(restored.Other));
        Assert.Equal(2, restored.Result.GetProperty("filesRestored").GetInt32());
        Assert.Empty(restored.Result.GetProperty("refusedFiles").EnumerateArray());
    }

    [Theory]
    [MemberData(nameof(Unreadable))]
    public void ABackupRestoreRefusesASettingsDocumentTheGateCannotRead(string name, byte[] stored)
    {
        var restored = Restore(stored);
        // Not written: the person keeps what they had, and the restore says which file it left out.
        Assert.True(Utf8("{\"DisplayLanguage\":\"fr\"}").SequenceEqual(restored.User), $"{name}: {Encoding.UTF8.GetString(restored.User)}");
        Assert.True(restored.Result.TryGetProperty("refusedFiles", out var refused), name);
        Assert.Equal(new[] { User + "/settings.json" }, refused.EnumerateArray().Select(e => e.GetString()).ToArray());
        // The rest of the backup is restored.
        Assert.Equal("{\"DisplayLanguage\":\"de\",\"Huge\":1e40}", Encoding.UTF8.GetString(restored.Other));
        Assert.Equal(1, restored.Result.GetProperty("filesRestored").GetInt32());
    }

    // A person's folder under another spelling of their id (upper case, hyphens), which the start-up migration puts in place
    // as theirs: its settings.json passes the same gate when a backup brings it in.
    [Theory]
    [InlineData("{\"DisplayLanguage\":\"ja\",\"Huge\":1e40}", "{\"DisplayLanguage\":\"\",\"Huge\":1e40}")]
    [InlineData("{'DisplayLanguage':'ja'}", null)]
    public void ABackupRestoreGatesAPersonsSettingsUnderAnySpellingOfTheirFolder(string stored, string? gated)
    {
        using var f = new ApiPluginFixture();
        var configPath = Path.Combine(f.Core.Root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);
        using (var s = File.Create(configPath)) new XmlSerializer(typeof(PluginConfiguration)).Serialize(s, f.Plugin.Configuration);
        var spelling = Guid.Parse(User).ToString("D").ToUpperInvariant();
        var path = Path.Combine(Directory.CreateDirectory(Path.Combine(f.Core.ConfigRoot, spelling)).FullName, "settings.json");
        File.WriteAllText(path, stored);
        var service = new JeBackupService(f.Core.ConfigRoot, configPath, () => f.Plugin.Secrets, f.Core.Logger);
        using var zip = new MemoryStream();
        service.Export(zip, JeBackupSecrets.Exclude, null);
        File.Delete(path);
        var result = JsonSerializer.SerializeToElement(service.Restore(new MemoryStream(zip.ToArray()), null));
        if (gated == null)
        {
            Assert.False(File.Exists(path));
            Assert.Equal(new[] { spelling + "/settings.json" }, result.GetProperty("refusedFiles").EnumerateArray().Select(e => e.GetString()).ToArray());
        }
        else
        {
            Assert.Equal(gated, File.ReadAllText(path));
        }
    }

    [Theory]
    [MemberData(nameof(Lossless))]
    public void TheStartUpFolderMigrationChangesOnlyTheDisplayLanguageBytes(string name, byte[] stored, byte[] gated)
    {
        using var f = new CoreFixture();
        var variant = Path.Combine(f.ConfigRoot, Guid.Parse(User).ToString("D").ToUpperInvariant());
        Directory.CreateDirectory(variant);
        File.WriteAllBytes(Path.Combine(variant, "settings.json"), stored);
        _ = new UserConfigurationManager(f.Paths.Object, f.Logger);
        var placed = File.ReadAllBytes(Path.Combine(f.ConfigRoot, User, "settings.json"));
        Assert.True(gated.SequenceEqual(placed), $"{name}: placed {Encoding.UTF8.GetString(placed)}, expected {Encoding.UTF8.GetString(gated)}");
    }
}
