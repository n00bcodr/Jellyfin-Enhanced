using System.Reflection;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace JE.Tests;

/// <summary>
/// The host's user types, as the pinned 12.2 and 10.11.11 servers have them (tests/fixtures/host-users), and their
/// classification (Helpers/UserAuthorityFields.cs): every property must be classified, and the user-authority
/// fingerprint must move with every access-deciding one and with no other.
/// </summary>
public class UserAuthorityFieldsTests
{
    /// <summary>The host types the fingerprint reads, and what the Dashboard and the user API save into them.</summary>
    internal static readonly string[] HostTypes =
    [
        "Jellyfin.Database.Implementations.Entities.User",
        "Jellyfin.Database.Implementations.Entities.Permission",
        "Jellyfin.Database.Implementations.Entities.Preference",
        "Jellyfin.Database.Implementations.Entities.AccessSchedule",
        "Jellyfin.Database.Implementations.Enums.PermissionKind",
        "Jellyfin.Database.Implementations.Enums.PreferenceKind",
        "MediaBrowser.Model.Users.UserPolicy",
        "MediaBrowser.Model.Configuration.UserConfiguration",
    ];

    private static readonly string[] Versions = ["12.2", "10.11.11"];

    private static string Fixture(string version) => Path.Combine(AppContext.BaseDirectory, "fixtures", "host-users", "user-fields-" + version + ".tsv");

    /// <summary>A host list's rows: type (simple name), member, member type ("enum" for an enum member), rw|ro or the enum value.</summary>
    internal static List<string[]> Rows(string version)
        => File.ReadAllLines(Fixture(version)).Where(l => l.Length > 0 && !l.StartsWith('#')).Select(l => l.Split('\t')).ToList();

    /// <summary>
    /// The rows of the host's own assemblies (the pinned image's /jellyfin, copied out by tests/backend/jellyfin_api.py), read
    /// as metadata: the same lines the checked-in list holds.
    /// </summary>
    internal static List<string> HostRows(string directory)
    {
        var paths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in Directory.EnumerateFiles(directory, "*.dll")) paths[Path.GetFileNameWithoutExtension(file)] = file;
        foreach (var file in ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator))
            paths.TryAdd(Path.GetFileNameWithoutExtension(file), file);
        using var context = new MetadataLoadContext(new PathAssemblyResolver(paths.Values));
        var assemblies = new[] { "Jellyfin.Database.Implementations", "MediaBrowser.Model" }.Select(a => context.LoadFromAssemblyPath(paths[a])).ToArray();
        var rows = new List<string>();
        foreach (var name in HostTypes)
        {
            var type = assemblies.Select(a => a.GetType(name)).FirstOrDefault(t => t != null)
                ?? throw new Xunit.Sdk.XunitException(name + " isn't in " + directory);
            if (type.IsEnum)
            {
                foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Static))
                    rows.Add(string.Join('\t', type.Name, field.Name, "enum", Convert.ToString(field.GetRawConstantValue(), System.Globalization.CultureInfo.InvariantCulture)));
            }
            else
            {
                foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0).OrderBy(p => p.Name, StringComparer.Ordinal))
                    rows.Add(string.Join('\t', type.Name, property.Name, property.PropertyType.ToString(), property.SetMethod?.IsPublic == true ? "rw" : "ro"));
            }
        }

        return rows;
    }

    /// <summary>
    /// The checked-in list is the pinned host's own (12.2 on the Jellyfin 12 build, 10.11.11 on the 10.11 one). With
    /// JE_USER_FIELDS_WRITE set to tests/fixtures/host-users, this test writes the list instead (see tests/host/README.md).
    /// </summary>
    [Fact]
    public void TheCheckedInListIsThePinnedHostsOwn()
    {
        var (version, api) = JellyfinApiAssembly.Pinned(JellyfinApiAssembly.CurrentLine);
        var directory = Path.GetDirectoryName(api)!;
        if (!File.Exists(Path.Combine(directory, "Jellyfin.Database.Implementations.dll")))
            throw new Xunit.Sdk.XunitException("Jellyfin " + version + "'s assemblies aren't at " + directory + ". Run: python3 tests/backend/jellyfin_api.py --target " + JellyfinApiAssembly.CurrentLine);
        var host = HostRows(directory);
        if (Environment.GetEnvironmentVariable("JE_USER_FIELDS_WRITE") is { Length: > 0 } output)
        {
            File.WriteAllLines(Path.Combine(output, "user-fields-" + version + ".tsv"),
                new[] { "# Jellyfin " + version + "'s user types (type, member, member type or enum, rw|ro or value); regenerate: tests/host/README.md" }.Concat(host));
            return;
        }

        Assert.Equal(host, Rows(version).Select(r => string.Join('\t', r)).ToList());
    }

    [Fact]
    public void EveryPropertyBothHostsHaveIsClassified()
    {
        foreach (var version in Versions)
        {
            var rows = Rows(version);
            Assert.True(rows.Count >= 140, version + ": " + rows.Count + " rows");
            Assert.Empty(UserAuthorityFields.Unclassified(rows.Select(r => (r[0], r[1]))));
        }
    }

    [Fact]
    public void NothingIsClassifiedThatNeitherHostHas()
    {
        var known = Versions.SelectMany(Rows).Select(r => r[0] + "." + r[1]).ToHashSet(StringComparer.Ordinal);
        var stale = UserAuthorityFields.Entity.Keys.Concat(UserAuthorityFields.Sources.Keys).Where(k => !known.Contains(k)).ToList();
        Assert.True(stale.Count == 0, "classified but on neither host: " + string.Join(", ", stale));
        // Each policy or configuration property is saved as a classified user property, permission or preference.
        var unsourced = UserAuthorityFields.Sources.Where(s => !UserAuthorityFields.Entity.ContainsKey(s.Value)).Select(s => s.Key).ToList();
        Assert.True(unsourced.Count == 0, "no classified source: " + string.Join(", ", unsourced));
    }

    /// <summary>A host that adds a property (a new policy field, permission, preference or user property) fails until it is classified.</summary>
    [Fact]
    public void APlantedPropertyIsReportedUnclassified()
    {
        var rows = Rows("12.2").Select(r => (r[0], r[1])).ToList();
        var planted = new[] { ("UserPolicy", "EnableTeleportAccess"), ("PermissionKind", "EnableTeleport"), ("PreferenceKind", "TeleportDestinations"), ("User", "TeleportLimit"), ("UserConfiguration", "TeleportStyle") };
        Assert.Equal(planted.Select(p => p.Item1 + "." + p.Item2), UserAuthorityFields.Unclassified(rows.Concat(planted)));
        // Until it is classified, the fingerprint reads an unknown user property (deny by default).
        Assert.Null(UserAuthorityFields.RoleOf("User", "TeleportLimit"));
    }

    /// <summary>The types this build was compiled with (Jellyfin's packages) have nothing unclassified either.</summary>
    [Fact]
    public void TheCompiledTypesAreClassified()
    {
        var rows = new List<(string, string)>();
        foreach (var type in new[] { typeof(User), typeof(Permission), typeof(Preference), typeof(AccessSchedule), typeof(MediaBrowser.Model.Users.UserPolicy), typeof(MediaBrowser.Model.Configuration.UserConfiguration) })
            rows.AddRange(type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Select(p => (type.Name, p.Name)));
        rows.AddRange(Enum.GetNames<PermissionKind>().Select(n => ("PermissionKind", n)));
        rows.AddRange(Enum.GetNames<PreferenceKind>().Select(n => ("PreferenceKind", n)));
        Assert.Empty(UserAuthorityFields.Unclassified(rows));
    }

    private static User Fresh()
    {
        var user = new User("alice", "default", "default") { Id = Guid.Parse("11111111-2222-3333-4444-555555555555") };
        foreach (var kind in Enum.GetValues<PermissionKind>()) user.SetPermission(kind, false);
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        user.SetPermission(PermissionKind.EnableAllChannels, true);
        return user;
    }

    /// <summary>
    /// Every permission, preference and settable user property moves the fingerprint exactly when it is classified as
    /// access-deciding: the fingerprint is the classification, not a list of its own.
    /// </summary>
    [Fact]
    public void TheFingerprintMovesWithEveryAccessDecidingFactAndNoOther()
    {
        var baseline = UserAuthority.Fingerprint(Fresh());
        Assert.Equal(baseline, UserAuthority.Fingerprint(Fresh()));
        var wrong = new List<string>();
        void Check(string name, bool access, Action<User> change)
        {
            var user = Fresh();
            change(user);
            if ((UserAuthority.Fingerprint(user) != baseline) != access) wrong.Add(name + (access ? " (access) didn't move it" : " (not access) moved it"));
        }

        foreach (var kind in Enum.GetValues<PermissionKind>())
            Check("PermissionKind." + kind, UserAuthorityFields.RoleOf("PermissionKind", kind.ToString()) == UserAuthorityFields.Role.Access, u => u.SetPermission(kind, !u.HasPermission(kind)));
        foreach (var kind in Enum.GetValues<PreferenceKind>())
            Check("PreferenceKind." + kind, UserAuthorityFields.RoleOf("PreferenceKind", kind.ToString()) == UserAuthorityFields.Role.Access, u => u.SetPreference(kind, ["0f4c8e3a9b2d4e6f8a1b3c5d7e9f0a1b"]));
        foreach (var property in typeof(User).GetProperties().Where(p => p.SetMethod?.IsPublic == true))
        {
            var type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
            object? other = type == typeof(bool) ? !(bool)(property.GetValue(Fresh()) ?? false)
                : type == typeof(int) ? 7 : type == typeof(long) ? 7L : type == typeof(string) ? "changed" : type == typeof(Guid) ? Guid.NewGuid()
                : type == typeof(DateTime) ? new DateTime(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc) : type.IsEnum ? Enum.GetValues(type).Cast<object>().Last()
                : null;
            if (other == null) continue;
            Check("User." + property.Name, UserAuthorityFields.RoleOf("User", property.Name) == UserAuthorityFields.Role.Access, u => property.SetValue(u, other));
        }

        Check("User.AccessSchedules", true, u => u.AccessSchedules.Add(new AccessSchedule(DynamicDayOfWeek.Monday, 8, 20, u.Id)));
        Assert.Empty(wrong);
    }

    [Fact]
    public void APreferenceSavedInAnotherOrderIsTheSameAuthority()
    {
        var one = UserChange.Read(Guid.NewGuid());
        var two = UserChange.Read(one.Id);
        one.SetPreference(PreferenceKind.BlockedTags, ["a", "b"]);
        two.SetPreference(PreferenceKind.BlockedTags, ["b", "a"]);
        Assert.Equal(UserAuthority.Fingerprint(one), UserAuthority.Fingerprint(two));
        // Bookkeeping that moves on every sign-in isn't authority.
        two.LastLoginDate = DateTime.UtcNow;
        two.LastActivityDate = DateTime.UtcNow;
        two.InvalidLoginAttemptCount = 2;
        Assert.Equal(UserAuthority.Fingerprint(one), UserAuthority.Fingerprint(two));
    }
}
