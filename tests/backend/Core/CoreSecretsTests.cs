using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;

namespace JE.Tests;

/// <summary>
/// The secrets store and its migration: every credential leaves the plugin configuration, the saved
/// XML and every configuration response carry placeholders only, existing features still read the
/// real values, saves can't wipe a key by accident, and the migration is idempotent and reversible.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSecretsTests
{
    private const string SeerrKey = "SEERR-0123456789abcdef0123456789abcdef";
    private const string TmdbKey = "TMDB-0123456789abcdef0123456789abcdef";
    private const string MdbKey = "MDB-0123456789abcdef";
    private const string ShokoKey = "SHOKO-0123456789abcdef";
    private const string AnalyticsSecret = "ANALYTICS-0123456789abcdef0123456789";
    private const string SonarrKey1 = "SONARR1-0123456789abcdef0123456789abcd";
    private const string SonarrKey2 = "SONARR2-0123456789abcdef0123456789abcd";
    private const string RadarrKey1 = "RADARR1-0123456789abcdef0123456789abcd";
    private const string RadarrKey2 = "RADARR2-0123456789abcdef0123456789abcd";

    // A configuration saved by a JE version before the secrets store, multi-instance era: the
    // config page wrote five-field rows and mirrored the first row into the legacy fields.
    private const string MultiInstanceXml = $$"""
        <?xml version="1.0" encoding="utf-8"?>
        <PluginConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
          <TMDB_API_KEY>{{TmdbKey}}</TMDB_API_KEY>
          <MdblistApiKey>{{MdbKey}}</MdblistApiKey>
          <JellyseerrEnabled>true</JellyseerrEnabled>
          <JellyseerrUrls>http://seerr.lan:5055</JellyseerrUrls>
          <JellyseerrApiKey>{{SeerrKey}}</JellyseerrApiKey>
          <ArrLinksEnabled>true</ArrLinksEnabled>
          <SonarrUrl>http://sonarr.lan:8989</SonarrUrl>
          <RadarrUrl>http://radarr.lan:7878</RadarrUrl>
          <SonarrUrlMappings />
          <RadarrUrlMappings>http://jf.example|http://radarr.example</RadarrUrlMappings>
          <SonarrInstances>[{"Name":"TV","Url":"http://sonarr.lan:8989","ApiKey":"{{SonarrKey1}}","UrlMappings":"","Enabled":true},{"Name":"Anime","Url":"http://sonarr-anime.lan:8989","ApiKey":"{{SonarrKey2}}","UrlMappings":""}]</SonarrInstances>
          <RadarrInstances>[{"Name":"Movies","Url":"http://radarr.lan:7878","ApiKey":"{{RadarrKey1}}","UrlMappings":"http://jf.example|http://radarr.example","Enabled":true},{"Name":"Radarr 4K","Url":"http://radarr4k.lan:7878/","ApiKey":"{{RadarrKey2}}","UrlMappings":"","Enabled":false}]</RadarrInstances>
          <ShokoUrl>http://shoko.lan:8111</ShokoUrl>
          <ShokoApiKey>{{ShokoKey}}</ShokoApiKey>
          <SonarrApiKey>{{SonarrKey1}}</SonarrApiKey>
          <RadarrApiKey>{{RadarrKey1}}</RadarrApiKey>
          <AnalyticsInstallId>install-1</AnalyticsInstallId>
          <AnalyticsInstallSecret>{{AnalyticsSecret}}</AnalyticsInstallSecret>
        </PluginConfiguration>
        """;

    // Older still: only the legacy single-instance fields, empty instance lists.
    private const string LegacySingleXml = $$"""
        <?xml version="1.0" encoding="utf-8"?>
        <PluginConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
          <SonarrUrl>http://sonarr.lan:8989</SonarrUrl>
          <SonarrApiKey>{{SonarrKey1}}</SonarrApiKey>
          <SonarrUrlMappings>http://jf|http://sonarr.public</SonarrUrlMappings>
          <RadarrUrl>http://radarr.lan:7878</RadarrUrl>
          <RadarrApiKey>{{RadarrKey1}}</RadarrApiKey>
          <SonarrInstances>[]</SonarrInstances>
          <RadarrInstances />
        </PluginConfiguration>
        """;

    private static readonly string[] AllKeys = [SeerrKey, TmdbKey, MdbKey, ShokoKey, AnalyticsSecret, SonarrKey1, SonarrKey2, RadarrKey1, RadarrKey2];

    private static PluginConfiguration FromXml(string xml)
    {
        using var reader = new StringReader(xml);
        return (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(reader)!;
    }

    // What Jellyfin writes to plugins/configurations/*.xml (its IXmlSerializer wraps XmlSerializer).
    private static string ToXml(PluginConfiguration config)
    {
        var sb = new StringBuilder();
        using (var writer = new StringWriter(sb)) new XmlSerializer(typeof(PluginConfiguration)).Serialize(writer, config);
        return sb.ToString();
    }

    private static void AssertNoCredential(string text, string what)
    {
        foreach (var key in AllKeys) Assert.False(text.Contains(key, StringComparison.Ordinal), $"{what} contains a credential ({key[..6]}…)");
        // Not even the distinctive middle of a key (a hint shows at most the last four characters).
        Assert.DoesNotContain("0123456789abcdef", text);
    }

    [Fact]
    public void MasksRevealOnlyTheLastFourCharactersOfLongValues()
    {
        Assert.Equal(SecretValue.MaskPrefix + "cdef", SecretValue.Mask("abcdefabcdefabcdef"));
        Assert.Equal(SecretValue.MaskPrefix, SecretValue.Mask("short-key"));
        Assert.Equal(string.Empty, SecretValue.Mask(""));
        Assert.True(SecretValue.IsPlaceholder(SecretValue.Mask("abcdefabcdefabcdef")));
        Assert.False(SecretValue.IsPlaceholder("abcdef"));
        Assert.Equal("ends cdef", SecretValue.Hint("abcdefabcdefabcdef"));
        Assert.Equal(string.Empty, SecretValue.Hint("short"));
        var handle = SecretValue.CreateHandle("0011");
        Assert.True(SecretValue.IsHandle(handle) && SecretValue.IsPlaceholder(handle));
        Assert.Equal("0011", SecretValue.HandleId(handle));
    }

    [Fact]
    public void StoreIsOwnerOnlyAtomicAndSurvivesReload()
    {
        using var env = new IntegrationEnvironment();
        var path = Path.Combine(env.Root, "data", SecretsStore.FileName);
        var store = new SecretsStore(path);
        store.Set("JellyseerrApiKey", SeerrKey);
        store.Set("arr:x", "value");
        store.Set("arr:x", "");
        Assert.True(File.Exists(path));
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.tmp.*"));
        var reloaded = new SecretsStore(path);
        Assert.Equal(SeerrKey, reloaded.Get("JellyseerrApiKey"));
        Assert.Null(reloaded.Get("arr:x"));
        Assert.Equal(["JellyseerrApiKey"], reloaded.Names());
        Assert.True(reloaded.Remove("JellyseerrApiKey"));
        Assert.False(reloaded.Remove("JellyseerrApiKey"));
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("\"x\"")]
    [InlineData("{\"secrets\":[]}")]
    public void AnUnreadableStoreIsLeftInPlaceNeverWrittenAndReadAgainOnceFixed(string content)
    {
        using var env = new IntegrationEnvironment();
        var path = Path.Combine(env.Root, SecretsStore.FileName);
        File.WriteAllText(path, content);
        var warnings = new List<string>();
        var now = DateTimeOffset.UtcNow;
        var store = new SecretsStore(path, warnings.Add, () => now);

        Assert.Null(store.Get("anything"));                // no exception, whatever the shape
        Assert.False(store.IsAvailable);
        Assert.Throws<SecretsStoreUnavailableException>(() => store.Set("JellyseerrApiKey", "typed-later"));
        Assert.Equal(content, File.ReadAllText(path));       // never moved, renamed or overwritten
        Assert.Single(Directory.GetFiles(env.Root));
        Assert.Single(warnings, w => w.Contains("could not be read"));

        // Fixed by the admin (or a transient lock gone): read again after the retry interval.
        File.WriteAllText(path, """{"version":1,"secrets":{"JellyseerrApiKey":"RESTORED-KEY-000000"}}""");
        Assert.Null(store.Get("JellyseerrApiKey"));
        now += SecretsStore.ReloadInterval;
        Assert.Equal("RESTORED-KEY-000000", store.Get("JellyseerrApiKey"));
        Assert.True(store.IsAvailable);
        store.Set("TMDB_API_KEY", "T");
        Assert.Equal("RESTORED-KEY-000000", new SecretsStore(path).Get("JellyseerrApiKey"));
    }

    [Fact]
    public void WhileTheStoreCantBeReadMigrationAndSavesLoseNothing()
    {
        using var fixture = new ApiPluginFixture();
        var config = Migrated(fixture);
        var path = fixture.Plugin.Secrets.FilePath;
        var original = File.ReadAllText(path);
        var placeholders = Credentials(config);

        // A restart while secrets.json is locked / half-edited.
        File.WriteAllText(path, original[..20]);
        var broken = new SecretsStore(path);
        var report = SecretsMigration.MigrateStored(config, broken);
        Assert.Equal(placeholders, Credentials(config));     // nothing blanked
        Assert.NotEmpty(report.Missing);
        Assert.Equal(original[..20], File.ReadAllText(path));

        // A save meanwhile: placeholders stay, a typed key stays in the configuration (pre-store layout).
        var incoming = Copy(config);
        incoming.MdblistApiKey = "TYPED-MDB-KEY-0000000";
        var saved = SecretsMigration.ApplyIncoming(incoming, config, broken);
        Assert.True(saved.StoreUnavailable);
        Assert.Equal(config.JellyseerrApiKey, incoming.JellyseerrApiKey);
        Assert.Equal(config.SonarrInstances, incoming.SonarrInstances);
        Assert.Equal("TYPED-MDB-KEY-0000000", incoming.MdblistApiKey);
        Assert.Equal(original[..20], File.ReadAllText(path));
        // A rollback now would replace every placeholder with nothing: refused.
        Assert.Throws<SecretsStoreUnavailableException>(() => SecretsMigration.Rollback(Copy(config), broken));

        // The file is back: the next start-up resolves every placeholder again and moves the typed key.
        File.WriteAllText(path, original);
        var healthy = new SecretsStore(path);
        SecretsMigration.MigrateStored(incoming, healthy);
        Assert.Empty(SecretsMigration.MigrateStored(incoming, healthy).Missing);
        Assert.Equal(SeerrKey, healthy.Get(nameof(PluginConfiguration.JellyseerrApiKey)));
        Assert.Equal("TYPED-MDB-KEY-0000000", healthy.Get(nameof(PluginConfiguration.MdblistApiKey)));
        Assert.Equal(4, healthy.Names().Count(n => n.StartsWith(SecretsStore.ArrKeyPrefix, StringComparison.Ordinal)));
    }

    [Fact]
    public void AStoreThatCantBeWrittenKeepsCredentialsInTheConfigurationAndSavesStillWork()
    {
        using var env = new IntegrationEnvironment();
        var blocker = Path.Combine(env.Root, "not-a-folder");
        File.WriteAllText(blocker, "");
        var store = new SecretsStore(Path.Combine(blocker, SecretsStore.FileName));
        var config = FromXml(MultiInstanceXml);

        var report = SecretsMigration.MigrateStored(config, store);   // no exception
        Assert.True(report.StoreUnavailable);
        Assert.Equal(SeerrKey, config.JellyseerrApiKey);
        Assert.Contains(SonarrKey1, config.SonarrInstances);

        var incoming = Copy(config);
        incoming.JellyseerrApiKey = "NEW-SEERR-KEY-0000000000";
        var saved = SecretsMigration.ApplyIncoming(incoming, config, store);   // the dashboard save does not fail
        Assert.True(saved.StoreUnavailable);
        Assert.Equal("NEW-SEERR-KEY-0000000000", incoming.JellyseerrApiKey);
        Assert.Equal(TmdbKey, incoming.TMDB_API_KEY);
        Assert.Equal([RadarrKey1, RadarrKey2], ArrRegistryMigration.Parse(incoming.RadarrInstances)!.Select(r => r.ApiKey));
    }

    [Fact]
    public void ImportHandlesExpireAndOnlyResolveForTheirServer()
    {
        using var env = new IntegrationEnvironment();
        var now = DateTimeOffset.UtcNow;
        var store = new SecretsStore(Path.Combine(env.Root, SecretsStore.FileName), null, () => now);
        var handle = store.AddPending(RadarrKey1, "http://radarr.lan:7878", TimeSpan.FromMinutes(1));
        Assert.DoesNotContain(RadarrKey1, handle);
        Assert.Equal(RadarrKey1, store.ResolvePending(handle, "http://RADARR.lan:7878/api"));
        Assert.Null(store.ResolvePending(handle, "http://evil.example:7878"));
        Assert.Null(store.ResolvePending(handle, "https://radarr.lan:7878"));
        Assert.Equal(string.Empty, store.ResolveSubmitted(handle, null, "http://evil.example"));
        now = now.AddMinutes(2);
        Assert.Null(store.ResolvePending(handle, "http://radarr.lan:7878"));
    }

    [Fact]
    public void ASubmittedMaskOnlyReleasesTheStoredKeyForItsOwnServer()
    {
        using var env = new IntegrationEnvironment();
        var store = new SecretsStore(Path.Combine(env.Root, SecretsStore.FileName));
        store.Set("JellyseerrApiKey", SeerrKey);
        var mask = SecretValue.Mask(SeerrKey);
        Assert.Equal(SeerrKey, store.ResolveSubmitted(mask, "JellyseerrApiKey"));
        Assert.Equal(SeerrKey, store.ResolveSubmitted(mask, "JellyseerrApiKey", "http://seerr.lan:5055", ["http://seerr.lan:5055/"]));
        Assert.Equal(string.Empty, store.ResolveSubmitted(mask, "JellyseerrApiKey", "http://attacker.example", ["http://seerr.lan:5055"]));
        Assert.Equal("typed", store.ResolveSubmitted(" typed ", "JellyseerrApiKey", "http://attacker.example", ["http://seerr.lan:5055"]));
        Assert.Equal(string.Empty, store.ResolveSubmitted(SecretValue.ClearToken, "JellyseerrApiKey"));
        Assert.Equal(string.Empty, store.ResolveSubmitted("", "JellyseerrApiKey"));
    }

    [Fact]
    public void MultiInstanceConfigMigratesEveryCredentialAndOldFeaturesStillReadThem()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        var config = FromXml(MultiInstanceXml);

        var report = SecretsMigration.MigrateStored(config, store);

        Assert.True(report.ConfigChanged);
        Assert.Empty(report.Missing);
        var xml = ToXml(config);
        AssertNoCredential(xml, "saved XML");
        AssertNoCredential(JsonSerializer.Serialize(config), "configuration endpoint JSON");
        // Every credential is now in the sidecar file, and only there.
        var sidecar = File.ReadAllText(store.FilePath);
        foreach (var key in AllKeys) Assert.Contains(key, sidecar);

        // Placeholders in the XML; real values through the accessors the features use.
        Assert.Equal(SecretValue.Mask(SeerrKey), config.JellyseerrApiKey);
        Assert.Equal(SeerrKey, config.GetJellyseerrApiKey());
        Assert.Equal(TmdbKey, config.GetTmdbApiKey());
        Assert.Equal(MdbKey, config.GetMdblistApiKey());
        Assert.Equal(ShokoKey, config.GetShokoApiKey());
        Assert.True(config.IsShokoConfigured());
        Assert.Equal(AnalyticsSecret, config.GetAnalyticsInstallSecret());
        // The legacy key mirrors are never read while instances exist, so they are not kept at all.
        Assert.Equal(string.Empty, config.SonarrApiKey);
        Assert.Equal(string.Empty, config.RadarrApiKey);
        Assert.Null(store.Get(nameof(PluginConfiguration.SonarrApiKey)));

        var sonarr = config.GetSonarrInstances();
        Assert.Equal(["TV", "Anime"], sonarr.Select(i => i.Name));
        Assert.Equal([SonarrKey1, SonarrKey2], sonarr.Select(i => i.ApiKey));
        var radarr = config.GetRadarrInstances();
        Assert.Equal([RadarrKey1, RadarrKey2], radarr.Select(i => i.ApiKey));
        Assert.Equal("http://jf.example|http://radarr.example", radarr[0].UrlMappings);
        Assert.Single(config.GetEnabledRadarrInstances());
        Assert.All(sonarr.Concat(radarr), i => Assert.True(Guid.TryParse(i.Id, out _)));
        Assert.Equal(4, sonarr.Concat(radarr).Select(i => i.Id).Distinct().Count());
    }

    [Fact]
    public void MigrationIsIdempotent()
    {
        using var fixture = new ApiPluginFixture();
        var config = FromXml(MultiInstanceXml);
        SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);
        var first = ToXml(config);
        var sidecar = File.ReadAllText(fixture.Plugin.Secrets.FilePath);

        var again = SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);

        Assert.False(again.ConfigChanged);
        Assert.Empty(again.Moved);
        Assert.Equal(first, ToXml(config));
        Assert.Equal(sidecar, File.ReadAllText(fixture.Plugin.Secrets.FilePath));
        // Reloading the saved XML and migrating again changes nothing either.
        var reloaded = FromXml(first);
        Assert.False(SecretsMigration.MigrateStored(reloaded, fixture.Plugin.Secrets).ConfigChanged);
        Assert.Equal(Credentials(config), Credentials(reloaded));
        Assert.Equal(sidecar, File.ReadAllText(fixture.Plugin.Secrets.FilePath));
    }

    private static string Credentials(PluginConfiguration c)
        => string.Join("\n", PluginConfiguration.StoredSecretFields.Select(c.ReadField).Append(c.SonarrInstances).Append(c.RadarrInstances));

    [Fact]
    public void LegacySingleInstanceFieldsBecomeARegistryInstance()
    {
        using var fixture = new ApiPluginFixture();
        var config = FromXml(LegacySingleXml);
        var before = config.GetSonarrInstances().Single();

        SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);

        AssertNoCredential(ToXml(config), "saved XML");
        var after = config.GetSonarrInstances().Single();
        // Exactly what the old legacy fallback synthesised, now a real row with an id.
        Assert.Equal((before.Name, before.Url, before.ApiKey, before.UrlMappings, before.Enabled), (after.Name, after.Url, after.ApiKey, after.UrlMappings, after.Enabled));
        Assert.True(Guid.TryParse(after.Id, out _));
        Assert.Equal(RadarrKey1, config.GetRadarrInstances().Single().ApiKey);
        Assert.Equal(string.Empty, config.SonarrApiKey);
        var rows = ArrRegistryMigration.Parse(config.SonarrInstances)!;
        Assert.Equal(SecretValue.Mask(SonarrKey1), Assert.Single(rows).ApiKey);
    }

    [Fact]
    public void APlaceholderWhoseStoredValueIsGoneIsKeptReportedAndNothingIsRemovedMeanwhile()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        var config = FromXml(MultiInstanceXml);
        SecretsMigration.MigrateStored(config, store);
        var masked = config.JellyseerrApiKey;
        store.Remove(nameof(PluginConfiguration.JellyseerrApiKey));
        // Something the configuration no longer sets, which would normally be removed.
        config.ShokoApiKey = "";

        var report = SecretsMigration.MigrateStored(config, store);

        Assert.Contains(nameof(PluginConfiguration.JellyseerrApiKey), report.Missing);
        Assert.Equal(masked, config.JellyseerrApiKey);
        Assert.Equal(string.Empty, config.GetJellyseerrApiKey());
        Assert.Equal(ShokoKey, store.Get(nameof(PluginConfiguration.ShokoApiKey)));

        // Restoring the value brings the credential back as it was.
        store.Set(nameof(PluginConfiguration.JellyseerrApiKey), SeerrKey);
        Assert.Equal(SeerrKey, config.GetJellyseerrApiKey());
        Assert.Empty(SecretsMigration.MigrateStored(config, store).Missing);
        Assert.Null(store.Get(nameof(PluginConfiguration.ShokoApiKey)));
    }

    [Theory]
    [InlineData("""[{"Name":"Sonarr","Url":"http://sonarr.lan:8989","ApiKey":""}]""", 1)]
    [InlineData("""[{"Name":"Old","Url":"http://old.lan:8989","ApiKey":""}]""", 2)]
    public void TheLegacyKeyIsUsedNotDroppedWhenNoRowHasAKey(string rowsJson, int expectedRows)
    {
        using var fixture = new ApiPluginFixture();
        var config = FromXml(LegacySingleXml);
        config.SonarrInstances = rowsJson;
        // What older JE versions use: the legacy pair, since no row has a key.
        var before = config.GetSonarrInstances().Single();
        Assert.Equal(SonarrKey1, before.ApiKey);

        SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);
        var again = SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);

        Assert.False(again.ConfigChanged);
        var usable = Assert.Single(config.GetSonarrInstances());
        Assert.Equal((SonarrKey1, "http://sonarr.lan:8989"), (usable.ApiKey, usable.Url.TrimEnd('/')));
        Assert.Equal(expectedRows, ArrRegistryMigration.Parse(config.SonarrInstances)!.Count);
        Assert.Equal(string.Empty, config.SonarrApiKey);
        AssertNoCredential(ToXml(config), "saved XML");

        // The same through a save.
        using var fixture2 = new ApiPluginFixture();
        var current = new PluginConfiguration();
        var incoming = FromXml(LegacySingleXml);
        incoming.SonarrInstances = rowsJson;
        SecretsMigration.ApplyIncoming(incoming, current, fixture2.Plugin.Secrets);
        Assert.Equal(SonarrKey1, Assert.Single(incoming.GetSonarrInstances()).ApiKey);
    }

    [Fact]
    public void WithoutAUsableRowOrALegacyAddressTheLegacyKeyIsKept()
    {
        using var fixture = new ApiPluginFixture();
        var config = FromXml(LegacySingleXml);
        config.SonarrUrl = "";
        config.SonarrInstances = """[{"Name":"x","Url":"http://sonarr.lan:8989","ApiKey":""}]""";
        SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);
        Assert.Equal(SonarrKey1, config.GetSecret(nameof(PluginConfiguration.SonarrApiKey)));
    }

    [Fact]
    public void RollbackRestoresThePreMigrationLayoutAndMigratingAgainRoundTrips()
    {
        using var fixture = new ApiPluginFixture();
        var original = FromXml(MultiInstanceXml);
        var config = FromXml(MultiInstanceXml);
        SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);

        var restored = SecretsMigration.Rollback(config, fixture.Plugin.Secrets);

        Assert.Equal(9, restored);
        foreach (var field in PluginConfiguration.StoredSecretFields)
            Assert.Equal(original.ReadField(field), config.ReadField(field));
        var rows = ArrRegistryMigration.Parse(config.RadarrInstances)!;
        Assert.Equal([RadarrKey1, RadarrKey2], rows.Select(r => r.ApiKey));
        // An older JE version reads these five fields only; they are exactly as before.
        var old = ArrRegistryMigration.Parse(original.RadarrInstances)!;
        Assert.Equal(old.Select(r => (r.Name, r.Url.TrimEnd('/'), r.ApiKey, r.UrlMappings, r.Enabled)), rows.Select(r => (r.Name, r.Url.TrimEnd('/'), r.ApiKey, r.UrlMappings, r.Enabled)));

        var again = SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);
        Assert.True(again.ConfigChanged);
        AssertNoCredential(ToXml(config), "saved XML after re-migration");
        Assert.Equal([RadarrKey1, RadarrKey2], config.GetRadarrInstances().Select(i => i.ApiKey));
    }

    private static PluginConfiguration Migrated(ApiPluginFixture fixture)
    {
        var config = FromXml(MultiInstanceXml);
        SecretsMigration.MigrateStored(config, fixture.Plugin.Secrets);
        return config;
    }

    private static PluginConfiguration Copy(PluginConfiguration config) => FromXml(ToXml(config));

    [Fact]
    public void SavingPlaceholdersOrBlanksKeepsEveryStoredCredential()
    {
        using var fixture = new ApiPluginFixture();
        var current = Migrated(fixture);
        var incoming = Copy(current);
        incoming.TMDB_API_KEY = "";      // a client that never loaded the field
        incoming.ShokoApiKey = null!;     // missing from the posted JSON

        SecretsMigration.ApplyIncoming(incoming, current, fixture.Plugin.Secrets);

        Assert.Equal(TmdbKey, incoming.GetTmdbApiKey());
        Assert.Equal(ShokoKey, incoming.GetShokoApiKey());
        Assert.Equal(SeerrKey, incoming.GetJellyseerrApiKey());
        Assert.Equal(SecretValue.Mask(TmdbKey), incoming.TMDB_API_KEY);
        Assert.Equal(current.SonarrInstances, incoming.SonarrInstances);
        AssertNoCredential(ToXml(incoming), "saved XML");
    }

    [Fact]
    public void SavingANewValueReplacesAndTheClearTokenRemoves()
    {
        using var fixture = new ApiPluginFixture();
        var current = Migrated(fixture);
        var incoming = Copy(current);
        incoming.JellyseerrApiKey = "  NEW-SEERR-KEY-0000000000  ";
        incoming.MdblistApiKey = SecretValue.ClearToken;

        SecretsMigration.ApplyIncoming(incoming, current, fixture.Plugin.Secrets);

        Assert.Equal("NEW-SEERR-KEY-0000000000", incoming.GetJellyseerrApiKey());
        Assert.Equal(SecretValue.Mask("NEW-SEERR-KEY-0000000000"), incoming.JellyseerrApiKey);
        Assert.Equal(string.Empty, incoming.MdblistApiKey);
        Assert.Null(fixture.Plugin.Secrets.Get(nameof(PluginConfiguration.MdblistApiKey)));
        Assert.DoesNotContain("NEW-SEERR-KEY", ToXml(incoming));
    }

    [Fact]
    public void SavingInstancesKeepsIdsAndKeysAssignsNewIdsAndPrunesRemovedKeys()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        var current = Migrated(fixture);
        var stored = ArrRegistryMigration.Parse(current.RadarrInstances)!;
        var keep = stored[0];
        var removed = stored[1];
        var handle = store.AddPending("IMPORTED-RADARR-KEY-00000000", "http://imported.lan:7878");
        // The page posts the first row (renamed, key still masked), drops the second and adds an
        // instance imported from Seerr (no id yet, key as an import handle).
        var incoming = Copy(current);
        incoming.RadarrInstances = JsonSerializer.Serialize(new object[]
        {
            new { Id = keep.Id, Name = "Movies (renamed)", Url = keep.Url, ApiKey = keep.ApiKey, UrlMappings = "", Enabled = true, Role = "standard", IsDefault = true },
            new { Name = "Imported 4K", Url = "http://imported.lan:7878", ApiKey = handle, Role = "4K", SeerrServerId = 3 },
        });

        SecretsMigration.ApplyIncoming(incoming, current, store);

        var rows = ArrRegistryMigration.Parse(incoming.RadarrInstances)!;
        Assert.Equal(2, rows.Count);
        Assert.Equal(keep.Id, rows[0].Id);
        Assert.Equal("Movies (renamed)", rows[0].Name);
        Assert.True(Guid.TryParse(rows[1].Id, out _));
        Assert.NotEqual(removed.Id, rows[1].Id);
        Assert.Equal(ArrInstanceRole.FourK, rows[1].Role);
        Assert.Equal(3, rows[1].SeerrServerId);
        Assert.All(rows, r => Assert.True(SecretValue.IsPlaceholder(r.ApiKey) && !SecretValue.IsHandle(r.ApiKey)));
        Assert.Equal(RadarrKey1, store.Get(SecretsStore.ArrKeyName(keep.Id)));
        Assert.Equal("IMPORTED-RADARR-KEY-00000000", store.Get(SecretsStore.ArrKeyName(rows[1].Id)));
        Assert.Null(store.Get(SecretsStore.ArrKeyName(removed.Id)));
        AssertNoCredential(ToXml(incoming), "saved XML");
        Assert.DoesNotContain("IMPORTED-RADARR-KEY", ToXml(incoming));
    }

    [Fact]
    public void AnImportedFirstInstanceMirroredIntoTheLegacyFieldsIsNotReportedAsLost()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        var current = Migrated(fixture);
        var handle = store.AddPending("IMPORTED-RADARR-KEY-00000000", "http://imported.lan:7878");
        var incoming = Copy(current);
        // What the config page posts: the first row mirrored into RadarrUrl / RadarrApiKey.
        incoming.RadarrInstances = JsonSerializer.Serialize(new[] { new { Name = "Imported", Url = "http://imported.lan:7878", ApiKey = handle } });
        incoming.RadarrUrl = "http://imported.lan:7878";
        incoming.RadarrApiKey = handle;

        var report = SecretsMigration.ApplyIncoming(incoming, current, store);

        Assert.Empty(report.NeedsReentry);
        Assert.Equal("IMPORTED-RADARR-KEY-00000000", incoming.GetRadarrInstances().Single().ApiKey);
        Assert.Equal(string.Empty, incoming.RadarrApiKey);
    }

    [Fact]
    public void ARowFromAClientWithoutIdsInheritsTheStoredIdByUrl()
    {
        using var fixture = new ApiPluginFixture();
        var current = Migrated(fixture);
        var stored = ArrRegistryMigration.Parse(current.SonarrInstances)!;
        var incoming = Copy(current);
        // An old cached config page: five fields, no ids, keys masked.
        incoming.SonarrInstances = JsonSerializer.Serialize(stored.Select(r => new { r.Name, r.Url, r.ApiKey, r.UrlMappings, r.Enabled }));

        SecretsMigration.ApplyIncoming(incoming, current, fixture.Plugin.Secrets);

        var rows = ArrRegistryMigration.Parse(incoming.SonarrInstances)!;
        Assert.Equal(stored.Select(r => r.Id), rows.Select(r => r.Id));
        Assert.Equal([SonarrKey1, SonarrKey2], incoming.GetSonarrInstances().Select(i => i.ApiKey));
    }

    [Fact]
    public void AnImportHandleForAnotherServerDoesNotResolveOnSave()
    {
        using var fixture = new ApiPluginFixture();
        var current = Migrated(fixture);
        var handle = fixture.Plugin.Secrets.AddPending("IMPORTED-KEY-0000000000000", "http://imported.lan:7878");
        var incoming = Copy(current);
        incoming.RadarrInstances = JsonSerializer.Serialize(new[] { new { Name = "Moved", Url = "http://elsewhere.lan:7878", ApiKey = handle } });

        var report = SecretsMigration.ApplyIncoming(incoming, current, fixture.Plugin.Secrets);

        Assert.Empty(incoming.GetRadarrInstances());
        Assert.Single(report.NeedsReentry);
        Assert.Contains(report.Notes, n => n.Contains("imported from Seerr"));
        Assert.DoesNotContain(fixture.Plugin.Secrets.Names(), n => fixture.Plugin.Secrets.Get(n) == "IMPORTED-KEY-0000000000000");
    }

    [Fact]
    public void ACorruptIncomingListIsNotSavedTheStoredOneIsKept()
    {
        using var fixture = new ApiPluginFixture();
        var current = Migrated(fixture);
        var keys = fixture.Plugin.Secrets.Names();
        var incoming = Copy(current);
        incoming.SonarrInstances = $$"""[{"Url":"http://sonarr.lan:8989","ApiKey":"{{SonarrKey1}}","Enabled":"true"}]""";

        var report = SecretsMigration.ApplyIncoming(incoming, current, fixture.Plugin.Secrets);

        Assert.Equal(current.SonarrInstances, incoming.SonarrInstances);
        Assert.Contains(report.Notes, n => n.Contains("unreadable"));
        Assert.Equal(keys, fixture.Plugin.Secrets.Names());
        AssertNoCredential(ToXml(incoming), "saved XML");
    }

    [Fact]
    public void AnUnreadableStoredListMovesToTheStoreAndRollbackPutsItBack()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        var config = FromXml(MultiInstanceXml);
        var corrupt = $$"""[{"Url":"http://sonarr.lan:8989","ApiKey":"{{SonarrKey1}}","Enabled":"true"}]""";
        config.SonarrInstances = corrupt;

        SecretsMigration.MigrateStored(config, store);

        Assert.Equal(SecretsMigration.CorruptListMarker, config.SonarrInstances);
        Assert.True(config.IsSonarrInstancesCorrupt());
        Assert.Equal(corrupt, store.Get(SecretsMigration.CorruptListStoreName(nameof(PluginConfiguration.SonarrInstances))));
        AssertNoCredential(ToXml(config), "saved XML");
        Assert.False(SecretsMigration.MigrateStored(config, store).ConfigChanged);
        // The log line describes the value without quoting it.
        Assert.DoesNotContain(SonarrKey1, JellyfinEnhancedController.DescribeCorruptList(corrupt));

        // Saving the marker back (the page leaves an unreadable list alone) changes nothing; a new list replaces it.
        var incoming = Copy(config);
        SecretsMigration.ApplyIncoming(incoming, config, store);
        Assert.Equal(SecretsMigration.CorruptListMarker, incoming.SonarrInstances);

        var rolledBack = Copy(config);
        SecretsMigration.Rollback(rolledBack, store);
        Assert.Equal(corrupt, rolledBack.SonarrInstances);

        var reset = Copy(config);
        reset.SonarrInstances = "[]";
        SecretsMigration.ApplyIncoming(reset, config, store);
        Assert.Null(store.Get(SecretsMigration.CorruptListStoreName(nameof(PluginConfiguration.SonarrInstances))));
    }

    [Fact]
    public void ASavedKeyIsNotCarriedToAnotherServer()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        var current = Migrated(fixture);
        var rows = ArrRegistryMigration.Parse(current.SonarrInstances)!;

        // Same server, other path / trailing slash / extra case: kept.
        var same = Copy(current);
        same.JellyseerrUrls = "http://SEERR.lan:5055/";
        same.ShokoUrl = "http://shoko.lan:8111/api";
        var sameRows = ArrRegistryMigration.Parse(current.SonarrInstances)!;
        sameRows[0].Url = "http://sonarr.lan:8989/sonarr";
        same.SonarrInstances = ArrRegistryMigration.Serialize(sameRows);
        var kept = SecretsMigration.ApplyIncoming(same, current, store);
        Assert.Empty(kept.NeedsReentry);
        Assert.Equal(SeerrKey, same.GetJellyseerrApiKey());
        Assert.Equal(ShokoKey, same.GetShokoApiKey());
        Assert.Equal(SonarrKey1, same.GetSonarrInstances()[0].ApiKey);

        // Another host for Seerr (added URL), Shoko and the first Sonarr row (same id, masked key): not kept.
        using var fixture2 = new ApiPluginFixture();
        store = fixture2.Plugin.Secrets;
        current = Migrated(fixture2);
        var moved = Copy(current);
        moved.JellyseerrUrls = "http://seerr.lan:5055\nhttps://attacker.example";
        moved.ShokoUrl = "http://attacker.example:8111";
        var movedRows = ArrRegistryMigration.Parse(current.SonarrInstances)!;
        movedRows[0].Url = "https://attacker.example";
        moved.SonarrInstances = ArrRegistryMigration.Serialize(movedRows);
        var report = SecretsMigration.ApplyIncoming(moved, current, store);
        Assert.Equal(3, report.NeedsReentry.Count);
        Assert.Equal(string.Empty, moved.GetJellyseerrApiKey());
        Assert.Equal(string.Empty, moved.GetShokoApiKey());
        Assert.Equal([SonarrKey2], moved.GetSonarrInstances().Select(i => i.ApiKey));
        Assert.Equal(TmdbKey, moved.GetTmdbApiKey());          // credentials without an address are unaffected
        Assert.DoesNotContain(store.Names(), n => store.Get(n) == SeerrKey);

        // A key typed for the new address is stored as usual.
        var typed = Copy(current);
        typed.JellyseerrUrls = "https://seerr.example";
        typed.JellyseerrApiKey = "TYPED-FOR-NEW-ADDRESS-000";
        SecretsMigration.ApplyIncoming(typed, current, store);
        Assert.Equal("TYPED-FOR-NEW-ADDRESS-000", typed.GetJellyseerrApiKey());
    }

    [Fact]
    public void InstanceIdsAreUniqueAcrossSonarrAndRadarr()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        const string shared = "0a6d76dc-1111-4c39-9a51-2f7f1b8d0a11";
        var config = FromXml(MultiInstanceXml);
        config.SonarrInstances = $$"""[{"Id":"{{shared}}","Name":"TV","Url":"http://sonarr.lan:8989","ApiKey":"{{SonarrKey1}}"}]""";
        config.RadarrInstances = $$"""[{"Id":"{{shared}}","Name":"Movies","Url":"http://radarr.lan:7878","ApiKey":"{{RadarrKey1}}"}]""";

        SecretsMigration.MigrateStored(config, store);

        var sonarr = ArrRegistryMigration.Parse(config.SonarrInstances)!.Single();
        var radarr = ArrRegistryMigration.Parse(config.RadarrInstances)!.Single();
        Assert.Equal(shared, sonarr.Id);
        Assert.NotEqual(shared, radarr.Id);
        Assert.Equal(SonarrKey1, config.GetSonarrInstances().Single().ApiKey);
        Assert.Equal(RadarrKey1, config.GetRadarrInstances().Single().ApiKey);

        // A save that copies the Sonarr row (with its id) into the Radarr list gets a new id there,
        // and dropping it from one list does not remove the other list's key.
        var incoming = Copy(config);
        incoming.RadarrInstances = $$"""[{"Id":"{{shared}}","Name":"Copy","Url":"http://radarr2.lan:7878","ApiKey":"RADARR-COPY-KEY-00000000"}]""";
        SecretsMigration.ApplyIncoming(incoming, config, store);
        Assert.NotEqual(shared, ArrRegistryMigration.Parse(incoming.RadarrInstances)!.Single().Id);
        Assert.Equal(SonarrKey1, store.Get(SecretsStore.ArrKeyName(shared)));
        Assert.Null(store.Get(SecretsStore.ArrKeyName(radarr.Id)));

        var removed = Copy(incoming);
        removed.SonarrInstances = "[]";
        SecretsMigration.ApplyIncoming(removed, incoming, store);
        Assert.Null(store.Get(SecretsStore.ArrKeyName(shared)));
        Assert.Equal("RADARR-COPY-KEY-00000000", removed.GetRadarrInstances().Single().ApiKey);
    }

    [Fact]
    public void TestButtonsSendAsciiStandInsThatResolveLikeThePlaceholders()
    {
        using var fixture = new ApiPluginFixture();
        var store = fixture.Plugin.Secrets;
        Migrated(fixture);
        var handle = store.AddPending("IMPORTED-KEY-0000000000000", "http://imported.lan:7878");
        var wireHandle = SecretValue.HandleTokenPrefix + SecretValue.HandleId(handle);
        Assert.True(SecretValue.SavedToken.All(c => c < 128) && wireHandle.All(c => c < 128));

        Assert.Equal(SeerrKey, store.ResolveSubmitted(SecretValue.SavedToken, nameof(PluginConfiguration.JellyseerrApiKey), "http://seerr.lan:5055", ["http://seerr.lan:5055"]));
        Assert.Equal(string.Empty, store.ResolveSubmitted(SecretValue.SavedToken, nameof(PluginConfiguration.JellyseerrApiKey), "http://evil.lan:5055", ["http://seerr.lan:5055"]));
        Assert.Equal("IMPORTED-KEY-0000000000000", store.ResolveSubmitted(wireHandle, null, "http://imported.lan:7878"));
        Assert.Equal(string.Empty, store.ResolveSubmitted(wireHandle, null, "http://other.lan:7878"));
        Assert.Equal("plain", SecretValue.FromWire("plain"));
    }

    [Fact]
    public void ThePluginSavePathPersistsPlaceholdersOnlyAndServesNoCredential()
    {
        using var fixture = new ApiPluginFixture();
        var plugin = fixture.Plugin;
        var incoming = FromXml(MultiInstanceXml);   // an API client posting real keys

        plugin.UpdateConfiguration(incoming);

        var live = plugin.Configuration;
        AssertNoCredential(ToXml(live), "saved XML");
        // GET /Plugins/{id}/Configuration serialises this object.
        AssertNoCredential(JsonSerializer.Serialize(live), "configuration endpoint JSON");
        Assert.Equal(SeerrKey, live.GetJellyseerrApiKey());
        Assert.Equal(AnalyticsSecret, live.GetAnalyticsInstallSecret());
        Assert.Equal([SonarrKey1, SonarrKey2], live.GetSonarrInstances().Select(i => i.ApiKey));

        // A second save of what the page loaded (placeholders everywhere) changes no credential.
        var sidecar = File.ReadAllText(plugin.Secrets.FilePath);
        plugin.UpdateConfiguration(Copy(live));
        Assert.Equal(sidecar, File.ReadAllText(plugin.Secrets.FilePath));
        Assert.Equal(SeerrKey, plugin.Configuration.GetJellyseerrApiKey());
    }

    [Fact]
    public void TheAnalyticsSecretIsWrittenThroughTheStore()
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        config.SetAnalyticsInstallSecret(AnalyticsSecret);
        Assert.Equal(SecretValue.Mask(AnalyticsSecret), config.AnalyticsInstallSecret);
        Assert.Equal(AnalyticsSecret, config.GetAnalyticsInstallSecret());
        config.SetAnalyticsInstallSecret("");
        Assert.Equal(string.Empty, config.AnalyticsInstallSecret);
        Assert.Null(fixture.Plugin.Secrets.Get(nameof(PluginConfiguration.AnalyticsInstallSecret)));
    }

    [Fact]
    public void EveryCredentialLikeConfigurationPropertyGoesThroughTheSecretsStore()
    {
        // Fails when a new *Key / *Secret / *Password / *Token setting is added without listing it in
        // PluginConfiguration.StoredSecretFields (which the migration, the save path and the masks use).
        var credentialLike = typeof(PluginConfiguration)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.PropertyType == typeof(string) && Regex.IsMatch(p.Name, "(Key|KEY|Secret|SECRET|Password|PASSWORD|Token|TOKEN|Passphrase)$"))
            .Select(p => p.Name)
            .OrderBy(n => n)
            .ToList();
        Assert.Equal(PluginConfiguration.StoredSecretFields.OrderBy(n => n), credentialLike);
    }

    [Fact]
    public void SeerrImportReturnsHandlesNotKeys()
    {
        using var fixture = new ApiPluginFixture();
        var json = """[{"id":1,"name":"Radarr 4K","hostname":"radarr4k.lan","port":7878,"useSsl":false,"baseUrl":"","apiKey":"REAL-RADARR-KEY-123456789","is4k":true},{"id":2,"name":"No key","hostname":"x","port":1}]""";

        var replaced = JellyfinEnhancedController.ReplaceImportedArrKeys(json);

        Assert.DoesNotContain("REAL-RADARR-KEY", replaced);
        using var doc = JsonDocument.Parse(replaced);
        var handle = doc.RootElement[0].GetProperty("apiKey").GetString();
        Assert.True(SecretValue.IsHandle(handle));
        Assert.Equal("REAL-RADARR-KEY-123456789", fixture.Plugin.Secrets.ResolvePending(handle, "http://radarr4k.lan:7878"));
        Assert.Null(fixture.Plugin.Secrets.ResolvePending(handle, "http://other.lan:7878"));
        Assert.Equal(string.Empty, doc.RootElement[1].GetProperty("apiKey").GetString());
        Assert.True(doc.RootElement[0].GetProperty("is4k").GetBoolean());
        Assert.Equal("[]", JellyfinEnhancedController.ReplaceImportedArrKeys("<html>"));
    }
}
