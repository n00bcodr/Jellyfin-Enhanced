using System.IO.Compression;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Primitives;
using Moq;

namespace JE.Tests;

/// <summary>
/// JE backup/export/restore: what goes in (no caches, no readable credential), passphrase
/// encryption, a full restore round trip through the plugin's real configuration path, and the
/// checks that refuse a damaged, tampered or foreign file before anything is written.
/// </summary>
[Collection("Plugin singleton")]
public class CoreBackupTests
{
    private const string Pass = "correct horse battery staple";
    private const string SeerrKey = "SEERR-KEY-0123456789abcdef";
    private const string ArrKey = "RADARR-KEY-0123456789abcdef";
    private const string User = "0123456789abcdef0123456789abcdef";

    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public string Data => F.Core.ConfigRoot;
        public string ConfigPath => Path.Combine(F.Core.Root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced.xml");
        public JeBackupService Service { get; }
        public PluginConfiguration Config => F.Plugin.Configuration;
        public SecretsStore Secrets => F.Plugin.Secrets;

        public Rig()
        {
            var c = Config;
            c.JellyseerrApiKey = SeerrKey;
            c.RadarrInstances = JsonSerializer.Serialize(new[] { new { Name = "Movies", Url = "http://radarr.lan:7878", ApiKey = ArrKey } });
            c.AnalyticsInstallId = "install-1";
            c.AnalyticsInstallSecret = "ANALYTICS-SECRET-0123456789";
            c.CalendarPageEnabled = true;
            SecretsMigration.MigrateStored(c, Secrets);
            SaveXml(c);
            Write(User + "/settings.json", "{\"theme\":\"dark\"}");
            Write(User + "/hidden-content.json", "{\"items\":[1]}");
            Write("reviews.json", "[{\"r\":1}]");
            Write("custom_branding/icon-transparent.png", "PNG");
            Write("tag-cache.json", "{\"cache\":true}");
            Write("cdn-cache/a.svg", "<svg/>");
            Write("arr-state/x.library.json", "{}");
            // The server-side cache (up to the admin's size cap) is never part of a backup.
            Write("server-cache/artwork/ab/" + new string('a', 64) + ".blob", "JEBC");
            Service = new JeBackupService(Data, ConfigPath, () => Secrets, F.Core.Logger);
        }

        public void SaveXml(PluginConfiguration c)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
            using var s = File.Create(ConfigPath);
            new XmlSerializer(typeof(PluginConfiguration)).Serialize(s, c);
        }

        public void Write(string relative, string text)
        {
            var path = Path.Combine(Data, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, text);
        }

        public byte[] Export(JeBackupSecrets mode, string? pass = null)
        {
            using var ms = new MemoryStream();
            Service.Export(ms, mode, pass);
            return ms.ToArray();
        }

        public void Dispose() => F.Dispose();
    }

    private static List<string> Entries(byte[] zip)
    {
        using var a = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        return a.Entries.Select(e => e.FullName).OrderBy(n => n, StringComparer.Ordinal).ToList();
    }

    private static string AllText(byte[] zip)
    {
        using var a = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        var sb = new StringBuilder();
        foreach (var e in a.Entries)
        {
            using var r = new StreamReader(e.Open());
            sb.Append(r.ReadToEnd());
        }
        return sb.ToString();
    }

    private static byte[] Rewrite(byte[] zip, Action<ZipArchive> change)
    {
        var ms = new MemoryStream();
        ms.Write(zip);
        using (var a = new ZipArchive(ms, ZipArchiveMode.Update, leaveOpen: true)) change(a);
        return ms.ToArray();
    }

    [Fact]
    public void ABackupHoldsSettingsAndStoresButNoCacheAndNoReadableCredential()
    {
        using var rig = new Rig();
        var zip = rig.Export(JeBackupSecrets.Encrypt, Pass);

        Assert.Equal(new[]
        {
            "config/Jellyfin.Plugin.JellyfinEnhanced.xml",
            "data/" + User + "/hidden-content.json",
            "data/" + User + "/settings.json",
            "data/custom_branding/icon-transparent.png",
            "data/reviews.json",
            "manifest.json",
            "secrets.enc",
        }, Entries(zip));
        var text = AllText(zip);
        Assert.DoesNotContain(SeerrKey, text);
        Assert.DoesNotContain(ArrKey, text);
        Assert.DoesNotContain("ANALYTICS-SECRET", text);
        JsonElement manifest;
        using (var a = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read))
        using (var m = a.GetEntry("manifest.json")!.Open())
            manifest = JsonDocument.Parse(m).RootElement.Clone();
        var names = manifest.GetProperty("secretNames").EnumerateArray().Select(n => n.GetString()).ToList();
        Assert.Contains(nameof(PluginConfiguration.JellyseerrApiKey), names);
        Assert.DoesNotContain(nameof(PluginConfiguration.AnalyticsInstallSecret), names);
        Assert.Equal(5, manifest.GetProperty("files").GetArrayLength());

        Assert.Throws<JeBackupException>(() => rig.Export(JeBackupSecrets.Encrypt, "short"));
        var plain = rig.Export(JeBackupSecrets.Exclude);
        Assert.DoesNotContain("secrets.enc", Entries(plain));
    }

    [Fact]
    public void APlainCredentialLeftInTheXmlIsBlankedInTheBackup()
    {
        using var rig = new Rig();
        // As after a failed secrets-store write: a raw key stays in the configuration file.
        var xml = File.ReadAllText(rig.ConfigPath);
        var raw = xml.Replace("<MdblistApiKey />", "<MdblistApiKey>MDBLIST-RAW-0123456789</MdblistApiKey>").Replace("<MdblistApiKey></MdblistApiKey>", "<MdblistApiKey>MDBLIST-RAW-0123456789</MdblistApiKey>");
        Assert.Contains("MDBLIST-RAW", raw);
        File.WriteAllText(rig.ConfigPath, raw);

        var zip = rig.Export(JeBackupSecrets.Exclude);

        var text = AllText(zip);
        Assert.DoesNotContain("MDBLIST-RAW", text);
        Assert.Contains(SecretValue.MaskPrefix, text);   // placeholders stay
    }

    [Fact]
    public void AnEncryptedBackupRestoresConfigurationUserDataAndCredentials()
    {
        using var rig = new Rig();
        var zip = rig.Export(JeBackupSecrets.Encrypt, Pass);
        var radarrId = JsonDocument.Parse(rig.Config.RadarrInstances).RootElement[0].GetProperty("Id").GetString()!;

        // Lose things: a user's folder, a setting, the stored keys; this install re-registered analytics.
        Directory.Delete(Path.Combine(rig.Data, User), true);
        rig.Config.CalendarPageEnabled = false;
        rig.Secrets.Remove(nameof(PluginConfiguration.JellyseerrApiKey));
        rig.Secrets.Remove(SecretsStore.ArrKeyName(radarrId));
        rig.Config.AnalyticsInstallId = "install-2";
        rig.Config.SetAnalyticsInstallSecret("ANALYTICS-SECRET-NEW-0123456");

        var wrong = rig.Service.Inspect(new MemoryStream(zip), "not the passphrase");
        Assert.False(wrong.PassphraseOk);
        var right = rig.Service.Inspect(new MemoryStream(zip), Pass);
        Assert.Equal((true, true, true, 1, 4), (right.PassphraseOk!.Value, right.HasSecrets, right.HasConfiguration, right.UserFolders, right.DataFiles));

        var refused = Assert.Throws<JeBackupException>(() => rig.Service.Restore(new MemoryStream(zip), "not the passphrase"));
        Assert.Equal("wrong_passphrase", refused.Code);
        Assert.Throws<JeBackupException>(() => rig.Service.Restore(new MemoryStream(zip), null));
        Assert.False(Directory.Exists(Path.Combine(rig.Data, User)));        // nothing written

        var result = rig.Service.Restore(new MemoryStream(zip), Pass);

        Assert.True(result.ConfigurationRestored);
        Assert.Equal(4, result.FilesRestored);
        Assert.Empty(result.MissingCredentials);
        Assert.Equal("{\"theme\":\"dark\"}", File.ReadAllText(Path.Combine(rig.Data, User, "settings.json")));
        var live = rig.F.Plugin.Configuration;
        Assert.True(live.CalendarPageEnabled);
        Assert.Equal(SeerrKey, live.GetJellyseerrApiKey());
        Assert.Equal(ArrKey, rig.Secrets.Get(SecretsStore.ArrKeyName(radarrId)));
        // The install's analytics identity is never taken from a backup.
        Assert.Equal("install-2", live.AnalyticsInstallId);
        Assert.Equal("ANALYTICS-SECRET-NEW-0123456", live.GetAnalyticsInstallSecret());
        Assert.Equal(live.Shortcuts!.Count, live.Shortcuts.Select(s => s.Name).Distinct().Count());

        // The state before the restore was kept, owner-only.
        var safety = Path.Combine(rig.Data, JeBackupService.DefaultFolderName, result.SafetyBackup!);
        Assert.True(File.Exists(safety));
        Assert.True(File.Exists(Path.ChangeExtension(safety, ".secrets.json")));
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(safety));
        Assert.DoesNotContain(User + "/settings.json", Entries(File.ReadAllBytes(safety)).Select(e => e.Replace("data/", "")));
        // Backups never contain earlier backups.
        Assert.DoesNotContain(Entries(rig.Export(JeBackupSecrets.Exclude)), e => e.Contains(JeBackupService.DefaultFolderName + "/"));
    }

    [Fact]
    public void ABackupWithoutCredentialsRestoresWithoutAPassphraseAndKeepsTheStoredKeys()
    {
        using var rig = new Rig();
        var zip = rig.Export(JeBackupSecrets.Exclude);
        rig.Config.CalendarPageEnabled = false;

        var result = rig.Service.Restore(new MemoryStream(zip), null);

        Assert.Equal(0, result.SecretsRestored);
        Assert.True(rig.F.Plugin.Configuration.CalendarPageEnabled);
        Assert.Equal(SeerrKey, rig.F.Plugin.Configuration.GetJellyseerrApiKey());
    }

    // The install moves Seerr and the Radarr instance to other servers after the backup was taken and
    // saves those servers' keys; returns the Radarr instance id.
    private static string MoveServers(Rig rig)
    {
        var rows = System.Text.Json.Nodes.JsonNode.Parse(rig.Config.RadarrInstances)!.AsArray();
        var id = (string)rows[0]!["Id"]!;
        rows[0]!["Url"] = "http://radarr-new.lan:7878";
        rig.Config.RadarrInstances = rows.ToJsonString();
        rig.Config.JellyseerrUrls = "http://seerr-b.lan:5055";
        rig.Secrets.Apply(new Dictionary<string, string>
        {
            [nameof(PluginConfiguration.JellyseerrApiKey)] = "SEERR-B-KEY-0123456789",
            [SecretsStore.ArrKeyName(id)] = "RADARR-NEW-KEY-0123456789",
        });
        Assert.Equal("SEERR-B-KEY-0123456789", rig.Config.GetJellyseerrApiKey());
        return id;
    }

    private static string? RestoredRadarrKeyText(Rig rig)
        => (string?)System.Text.Json.Nodes.JsonNode.Parse(rig.F.Plugin.Configuration.RadarrInstances)!.AsArray()[0]!["ApiKey"];

    [Fact]
    public void ABackupWithoutCredentialsNeverGivesThisInstallsKeyToTheOldServerItPointsAt()
    {
        using var rig = new Rig();
        rig.Config.JellyseerrUrls = "http://seerr-a.lan:5055";
        rig.SaveXml(rig.Config);
        var zip = rig.Export(JeBackupSecrets.Exclude);
        var radarrId = MoveServers(rig);

        var result = rig.Service.Restore(new MemoryStream(zip), null);

        var live = rig.F.Plugin.Configuration;
        Assert.Equal("http://seerr-a.lan:5055", live.JellyseerrUrls);
        Assert.Equal(string.Empty, live.GetJellyseerrApiKey());          // not Seerr B's key sent to Seerr A
        Assert.Equal(string.Empty, RestoredRadarrKeyText(rig));
        Assert.Contains(nameof(PluginConfiguration.JellyseerrApiKey), result.MissingCredentials);
        Assert.Contains("arr instance key " + radarrId, result.MissingCredentials);
        Assert.DoesNotContain("SEERR-B-KEY", File.ReadAllText(rig.ConfigPath));
    }

    [Fact]
    public void AnEncryptedBackupBringsItsOwnKeysForTheServersItPointsAt()
    {
        using var rig = new Rig();
        rig.Config.JellyseerrUrls = "http://seerr-a.lan:5055";
        rig.SaveXml(rig.Config);
        var zip = rig.Export(JeBackupSecrets.Encrypt, Pass);
        var radarrId = MoveServers(rig);

        var result = rig.Service.Restore(new MemoryStream(zip), Pass);

        Assert.Empty(result.MissingCredentials);
        Assert.Equal(SeerrKey, rig.F.Plugin.Configuration.GetJellyseerrApiKey());
        Assert.StartsWith(SecretValue.MaskPrefix, RestoredRadarrKeyText(rig));
        Assert.Equal(ArrKey, rig.Secrets.Get(SecretsStore.ArrKeyName(radarrId)));
    }

    [Fact]
    public void TheArrAuditLogIsBackedUpButARestoreNeverRollsItBack()
    {
        using var rig = new Rig();
        rig.Write("arr-audit.jsonl", "{\"day\":1}\n");
        rig.Write("arr-audit.jsonl.1", "{\"day\":0}\n");
        var zip = rig.Export(JeBackupSecrets.Exclude);
        Assert.Contains("data/arr-audit.jsonl", Entries(zip));
        Assert.Contains("data/arr-audit.jsonl.1", Entries(zip));
        rig.Write("arr-audit.jsonl", "{\"day\":1}\n{\"day\":5}\n");
        File.Delete(Path.Combine(rig.Data, "arr-audit.jsonl.1"));

        var result = rig.Service.Restore(new MemoryStream(zip), null);

        Assert.Equal("{\"day\":1}\n{\"day\":5}\n", File.ReadAllText(Path.Combine(rig.Data, "arr-audit.jsonl")));
        Assert.False(File.Exists(Path.Combine(rig.Data, "arr-audit.jsonl.1")));
        Assert.Equal(4, result.FilesRestored);
        Assert.True(JeBackupService.IsInstallHistory("arr-audit.jsonl.5"));
        Assert.False(JeBackupService.IsInstallHistory(User + "/arr-audit.jsonl"));
    }

    [Fact]
    public void TheSafetyCopyAndItsSecretsStayInTheDataFolderWhateverBackupFolderIsChosen()
    {
        using var rig = new Rig();
        var share = Path.Combine(rig.F.Core.Root, "nas-share");
        Directory.CreateDirectory(share);
        rig.Config.BackupFolder = share;
        var zip = rig.Export(JeBackupSecrets.Exclude);

        var result = rig.Service.Restore(new MemoryStream(zip), null);

        Assert.Empty(Directory.GetFiles(share));
        var safety = Path.Combine(rig.Data, JeBackupService.DefaultFolderName, result.SafetyBackup!);
        Assert.True(File.Exists(safety));
        Assert.Contains(SeerrKey, File.ReadAllText(Path.ChangeExtension(safety, ".secrets.json")));
    }

    [Fact]
    public void AnUnreadableInstanceListIsNotExportedAsItIs()
    {
        // Left in the XML when the secrets store could not take its text: it may hold plain keys.
        var xml = Encoding.UTF8.GetBytes("<PluginConfiguration><RadarrInstances>[{\"Name\":\"M\",\"ApiKey\":\"RAW-RADARR-KEY-0123\",</RadarrInstances><SonarrInstances>" + SecretsMigration.CorruptListMarker + "</SonarrInstances></PluginConfiguration>");

        var text = Encoding.UTF8.GetString(JeBackupService.ScrubConfigurationXml(xml));

        Assert.DoesNotContain("RAW-RADARR-KEY", text);
        Assert.Contains("<RadarrInstances>" + SecretsMigration.CorruptListMarker + "</RadarrInstances>", text);
        Assert.Contains("<SonarrInstances>" + SecretsMigration.CorruptListMarker + "</SonarrInstances>", text);
    }

    [Theory]
    [InlineData("checksum")]
    [InlineData("traversal")]
    [InlineData("secrets-file")]
    [InlineData("newer")]
    [InlineData("missing")]
    [InlineData("not-a-backup")]
    public void ADamagedOrForeignFileIsRefusedBeforeAnythingIsWritten(string damage)
    {
        using var rig = new Rig();
        var zip = rig.Export(JeBackupSecrets.Exclude);
        byte[] Manifest(Func<string, string> edit) => Rewrite(zip, a =>
        {
            var m = a.GetEntry("manifest.json")!;
            string text;
            using (var r = new StreamReader(m.Open())) text = r.ReadToEnd();
            m.Delete();
            using var w = new StreamWriter(a.CreateEntry("manifest.json").Open());
            w.Write(edit(text));
        });
        // Same bytes as reviews.json, so the manifest's size and checksum still match.
        byte[] Listed(string name) => Rewrite(Manifest(t => t.Replace("\"data/reviews.json\"", "\"" + name + "\"")), a =>
        {
            using var w = a.CreateEntry(name).Open();
            w.Write(Encoding.UTF8.GetBytes("[{\"r\":1}]"));
        });
        var secretsBefore = File.ReadAllText(rig.Secrets.FilePath);
        byte[] bad = damage switch
        {
            "checksum" => Rewrite(zip, a =>
            {
                a.GetEntry("data/reviews.json")!.Delete();
                using var w = new StreamWriter(a.CreateEntry("data/reviews.json").Open());
                w.Write("[{\"r\":2}]");
            }),
            // A listed entry with a valid checksum, but a name that escapes the data folder or names
            // a file restores must never write (the secrets file).
            "traversal" => Listed("data/../../evil.json"),
            "secrets-file" => Listed("data/secrets.json"),
            "newer" => Manifest(t => t.Replace("\"version\": 1", "\"version\": 99")),
            "missing" => Rewrite(zip, a => a.GetEntry("data/reviews.json")!.Delete()),
            _ => Encoding.UTF8.GetBytes("PK not really"),
        };
        File.Delete(Path.Combine(rig.Data, "reviews.json"));

        Assert.Throws<JeBackupException>(() => rig.Service.Restore(new MemoryStream(bad), null));

        Assert.False(File.Exists(Path.Combine(rig.Data, "reviews.json")));
        Assert.False(File.Exists(Path.Combine(rig.F.Core.Root, "evil.json")));
        Assert.Equal(secretsBefore, File.ReadAllText(rig.Secrets.FilePath));
        Assert.False(Directory.Exists(Path.Combine(rig.Data, JeBackupService.DefaultFolderName)));   // not even a safety copy
    }

    [Fact]
    public void ThePassphraseBoxRejectsAWrongPassphraseAndTampering()
    {
        var sealedBytes = JeBackupService.Seal(Encoding.UTF8.GetBytes("{\"a\":\"b\"}"), Pass, 100_000);
        Assert.Equal("{\"a\":\"b\"}", Encoding.UTF8.GetString(JeBackupService.Open(sealedBytes, Pass)));
        Assert.Equal("wrong_passphrase", Assert.Throws<JeBackupException>(() => JeBackupService.Open(sealedBytes, Pass + "x")).Code);
        var box = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(sealedBytes)!;
        var cipher = Convert.FromBase64String(box["ciphertext"].GetString()!);
        cipher[0] ^= 1;
        var tampered = JsonSerializer.SerializeToUtf8Bytes(box.ToDictionary(k => k.Key, k => k.Key == "ciphertext" ? (object)Convert.ToBase64String(cipher) : k.Value));
        Assert.Throws<JeBackupException>(() => JeBackupService.Open(tampered, Pass));
        Assert.NotEqual(sealedBytes, JeBackupService.Seal(Encoding.UTF8.GetBytes("{\"a\":\"b\"}"), Pass, 100_000));   // fresh salt and nonce
    }

    [Fact]
    public void ScheduledBackupsRotateAndAreOwnerOnly()
    {
        using var rig = new Rig();
        var folder = Path.Combine(rig.F.Core.Root, "elsewhere");
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, JeBackupService.ScheduledPrefix + "20200101-000000.zip"), "old");
        File.WriteAllText(Path.Combine(folder, JeBackupService.ScheduledPrefix + "20210101-000000.zip"), "old");
        File.WriteAllText(Path.Combine(folder, "unrelated.zip"), "keep");

        var path = rig.Service.WriteToFolder(folder, JeBackupSecrets.Exclude, null, 2);

        Assert.Equal(new[] { JeBackupService.ScheduledPrefix + "20210101-000000.zip", Path.GetFileName(path), "unrelated.zip" },
            Directory.GetFiles(folder).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal));
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        Assert.Contains("data/reviews.json", Entries(File.ReadAllBytes(path)));
    }

    [Fact]
    public async Task TheTaskRefusesToDropCredentialsSilently()
    {
        using var rig = new Rig();
        rig.Config.BackupFolder = Path.Combine(rig.F.Core.Root, "task-out");
        rig.Config.BackupIncludeSecrets = true;
        var task = new Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks.JeBackupTask(rig.Service, rig.F.Core.Logger);
        await Assert.ThrowsAsync<InvalidOperationException>(() => task.ExecuteAsync(new Progress<double>(), default));

        rig.Config.SetSecret(nameof(PluginConfiguration.BackupPassphrase), Pass);
        Assert.StartsWith(SecretValue.MaskPrefix, rig.Config.BackupPassphrase);
        await task.ExecuteAsync(new Progress<double>(), default);
        var file = Assert.Single(Directory.GetFiles(rig.Config.BackupFolder));
        Assert.Contains("secrets.enc", Entries(File.ReadAllBytes(file)));
    }

    [Fact]
    public async Task TheRoutesAreAdminOnlyAndRestoreNeedsConfirmation()
    {
        using var rig = new Rig();
        var zip = rig.Export(JeBackupSecrets.Exclude);
        var callers = new TestCallers();
        JeBackupController Make(bool admin, Dictionary<string, StringValues>? fields = null, System.Security.Claims.ClaimsPrincipal? caller = null)
        {
            var c = new JeBackupController(rig.Service, callers.Users.Object, rig.F.Core.Logger)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            c.HttpContext.User = caller ?? callers.Person(admin);
            if (fields != null)
            {
                var files = new FormFileCollection { new FormFile(new MemoryStream(zip), 0, zip.Length, "file", "backup.zip") };
                c.Request.ContentType = "multipart/form-data; boundary=x";
                c.Request.Form = new FormCollection(fields, files);
            }
            return c;
        }

        Assert.IsType<ForbidResult>(Make(false).Export(new JeBackupExportRequest()));
        // An API key (the administrator role claim, no person) and a user Jellyfin doesn't know are refused too.
        Assert.IsType<ForbidResult>(Make(false, caller: TestCallers.ApiKey()).Export(new JeBackupExportRequest()));
        Assert.IsType<ForbidResult>(await Make(false, new() { ["confirm"] = "restore" }, TestCallers.Unknown()).Restore());
        Assert.IsType<ForbidResult>(await Make(false, new()).Inspect());
        Assert.IsType<ForbidResult>(await Make(false, new() { ["confirm"] = "restore" }).Restore());

        var download = Assert.IsType<FileStreamResult>(Make(true).Export(new JeBackupExportRequest { Secrets = "exclude" }));
        Assert.Equal("application/zip", download.ContentType);
        Assert.StartsWith(JeBackupService.ScheduledPrefix, download.FileDownloadName);
        Assert.IsType<BadRequestObjectResult>(Make(true).Export(new JeBackupExportRequest { Secrets = "plain" }));
        Assert.IsType<BadRequestObjectResult>(Make(true).Export(new JeBackupExportRequest { Secrets = "encrypt", Passphrase = "short" }));

        var summary = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(await Make(true, new()).Inspect()).Value);
        Assert.Contains("\"hasConfiguration\":true", summary);
        Assert.IsType<BadRequestObjectResult>(await Make(true, new()).Restore());
        var restored = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(await Make(true, new() { ["confirm"] = "restore" }).Restore()).Value);
        Assert.Contains("\"configurationRestored\":true", restored);
    }

    [Fact]
    public void ShortcutsAreNotDoubledWhenAConfigurationIsReadBack()
    {
        var config = new PluginConfiguration();
        config.Shortcuts!.RemoveAt(0);
        using var ms = new MemoryStream();
        new XmlSerializer(typeof(PluginConfiguration)).Serialize(ms, config);

        var parsed = JeBackupService.ParseConfiguration(ms.ToArray());

        Assert.Equal(config.Shortcuts.Select(s => s.Name), parsed.Shortcuts!.Select(s => s.Name));
    }
}
