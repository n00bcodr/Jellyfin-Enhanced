using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Database.Implementations.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Every property of the host's user types, classified once: whether it decides what the person may see or reach
    /// (<see cref="Role.Access"/>) or not. <see cref="UserAuthority.Fingerprint"/> is DERIVED from this table: it reads every
    /// property of the user, each permission and each preference, and leaves out only what is classified
    /// <see cref="Role.NotAccess"/>, so a property nobody classified (a newer Jellyfin's) is part of it.
    /// <para>
    /// The host lists are <c>tests/fixtures/host-users/user-fields-&lt;version&gt;.tsv</c>, read from the 12.2 and 10.11.11
    /// assemblies (tests/host/README.md says how to regenerate them); the tests fail on any property they list that isn't
    /// classified here, and on a name here that neither host has. <c>UserPolicy</c> and <c>UserConfiguration</c> (what the
    /// Dashboard and the user API save) aren't read by the fingerprint: each of their properties names the user property,
    /// permission or preference it is saved as, whose class it takes.
    /// </para>
    /// </summary>
    internal static class UserAuthorityFields
    {
        /// <summary>A property's class.</summary>
        internal enum Role
        {
            /// <summary>Decides what the person may see or reach (items, libraries, channels, Live TV, other people's content), or what they may do: part of the fingerprint.</summary>
            Access,

            /// <summary>Doesn't: identity, credentials, bookkeeping, playback and display preferences.</summary>
            NotAccess,
        }

        private const Role A = Role.Access;
        private const Role N = Role.NotAccess;

        /// <summary>"Type.Member" (the type's simple name) → class and why, for User, its permission, preference and
        /// access-schedule rows, and the PermissionKind and PreferenceKind members.</summary>
        internal static readonly IReadOnlyDictionary<string, (Role Role, string Why)> Entity = new Dictionary<string, (Role, string)>(StringComparer.Ordinal)
        {
            ["User.AccessSchedules"] = (A, "parental schedule: when the person may use the server"),
            ["User.AudioLanguagePreference"] = (N, "playback preference"),
            ["User.AuthenticationProviderId"] = (N, "how the password is checked, not what it opens"),
            ["User.CastReceiverId"] = (N, "playback preference"),
            ["User.DisplayCollectionsView"] = (N, "display preference"),
            ["User.DisplayMissingEpisodes"] = (A, "decides whether missing episodes are part of the person's queries"),
            ["User.DisplayPreferences"] = (N, "display preferences"),
            ["User.EnableAutoLogin"] = (N, "sign-in convenience"),
            ["User.EnableLocalPassword"] = (N, "sign-in mechanics"),
            ["User.EnableNextEpisodeAutoPlay"] = (N, "playback preference"),
            ["User.EnableUserPreferenceAccess"] = (A, "policy: whether the person may change their own preferences"),
            ["User.HidePlayedInLatest"] = (N, "display preference"),
            ["User.Id"] = (N, "identity: every cache is keyed by it already"),
            ["User.InternalId"] = (N, "identity"),
            ["User.InvalidLoginAttemptCount"] = (N, "bookkeeping, moves on every failed sign-in; a lockout shows as IsDisabled"),
            ["User.ItemDisplayPreferences"] = (N, "display preferences"),
            ["User.LastActivityDate"] = (N, "bookkeeping, moves with activity"),
            ["User.LastLoginDate"] = (N, "bookkeeping, moves on every sign-in"),
            ["User.LoginAttemptsBeforeLockout"] = (N, "lockout threshold; a lockout itself shows as IsDisabled"),
            ["User.MaxActiveSessions"] = (N, "how many sessions at once, not what they open"),
            ["User.MaxParentalRatingScore"] = (A, "parental limit"),
            ["User.MaxParentalRatingSubScore"] = (A, "parental limit"),
            ["User.MustUpdatePassword"] = (N, "sign-in mechanics"),
            ["User.NormalizedUsername"] = (N, "name (a rename is announced on both versions)"),
            ["User.Password"] = (N, "credential: never part of a cache key"),
            ["User.PasswordResetProviderId"] = (N, "sign-in mechanics"),
            ["User.Permissions"] = (A, "each permission row, by its kind's class"),
            ["User.PlayDefaultAudioTrack"] = (N, "playback preference"),
            ["User.Preferences"] = (A, "each preference row, by its kind's class"),
            ["User.ProfileImage"] = (N, "the person's avatar"),
            ["User.RememberAudioSelections"] = (N, "playback preference"),
            ["User.RememberSubtitleSelections"] = (N, "playback preference"),
            ["User.RemoteClientBitrateLimit"] = (N, "streaming quality, not what can be opened"),
            ["User.RowVersion"] = (N, "bookkeeping, moves on every save"),
            ["User.SubtitleLanguagePreference"] = (N, "playback preference"),
            ["User.SubtitleMode"] = (N, "playback preference"),
            ["User.SyncPlayAccess"] = (A, "policy: whether the person may create or join SyncPlay groups"),
            ["User.Username"] = (N, "name (a rename is announced on both versions)"),

            ["Permission.Id"] = (N, "row bookkeeping"),
            ["Permission.Kind"] = (A, "which permission"),
            ["Permission.RowVersion"] = (N, "row bookkeeping"),
            ["Permission.UserId"] = (N, "row owner"),
            ["Permission.Value"] = (A, "the permission's value"),
            ["Preference.Id"] = (N, "row bookkeeping"),
            ["Preference.Kind"] = (A, "which preference"),
            ["Preference.RowVersion"] = (N, "row bookkeeping"),
            ["Preference.UserId"] = (N, "row owner"),
            ["Preference.Value"] = (A, "the preference's value (a set: compared without its order)"),
            ["AccessSchedule.DayOfWeek"] = (A, "parental schedule"),
            ["AccessSchedule.EndHour"] = (A, "parental schedule"),
            ["AccessSchedule.Id"] = (N, "row bookkeeping"),
            ["AccessSchedule.StartHour"] = (A, "parental schedule"),
            ["AccessSchedule.UserId"] = (N, "row owner"),

            ["PermissionKind.IsAdministrator"] = (A, "role"),
            ["PermissionKind.IsHidden"] = (A, "hidden from sign-in screens: decides whether their reviews show"),
            ["PermissionKind.IsDisabled"] = (A, "may not sign in; their reviews and poster data go"),
            ["PermissionKind.EnableSharedDeviceControl"] = (A, "may control shared devices"),
            ["PermissionKind.EnableRemoteAccess"] = (A, "may reach the server from outside the network"),
            ["PermissionKind.EnableLiveTvManagement"] = (A, "may manage Live TV"),
            ["PermissionKind.EnableLiveTvAccess"] = (A, "may see Live TV channels and programmes"),
            ["PermissionKind.EnableMediaPlayback"] = (A, "may play anything"),
            ["PermissionKind.EnableAudioPlaybackTranscoding"] = (N, "how a stream is delivered, not what can be opened"),
            ["PermissionKind.EnableVideoPlaybackTranscoding"] = (N, "how a stream is delivered, not what can be opened"),
            ["PermissionKind.EnableContentDeletion"] = (A, "may delete items"),
            ["PermissionKind.EnableContentDownloading"] = (A, "may download items"),
            ["PermissionKind.EnableSyncTranscoding"] = (N, "how a download is delivered, not what can be opened"),
            ["PermissionKind.EnableMediaConversion"] = (N, "how a download is delivered, not what can be opened"),
            ["PermissionKind.EnableAllDevices"] = (A, "may use every device"),
            ["PermissionKind.EnableAllChannels"] = (A, "channel access"),
            ["PermissionKind.EnableAllFolders"] = (A, "library access"),
            ["PermissionKind.EnablePublicSharing"] = (A, "may share publicly"),
            ["PermissionKind.EnableRemoteControlOfOtherUsers"] = (A, "may control other people's sessions"),
            ["PermissionKind.EnablePlaybackRemuxing"] = (N, "how a stream is delivered, not what can be opened"),
            ["PermissionKind.ForceRemoteSourceTranscoding"] = (N, "how a stream is delivered, not what can be opened"),
            ["PermissionKind.EnableCollectionManagement"] = (A, "may manage collections"),
            ["PermissionKind.EnableSubtitleManagement"] = (A, "may manage subtitles"),
            ["PermissionKind.EnableLyricManagement"] = (A, "may manage lyrics"),

            ["PreferenceKind.BlockedTags"] = (A, "parental: items with these tags are hidden"),
            ["PreferenceKind.BlockedChannels"] = (A, "channel access"),
            ["PreferenceKind.BlockedMediaFolders"] = (A, "library access"),
            ["PreferenceKind.EnabledDevices"] = (A, "which devices the person may use"),
            ["PreferenceKind.EnabledChannels"] = (A, "channel access"),
            ["PreferenceKind.EnabledFolders"] = (A, "library access"),
            ["PreferenceKind.EnableContentDeletionFromFolders"] = (A, "where the person may delete"),
            ["PreferenceKind.LatestItemExcludes"] = (N, "display: libraries left out of the home screen's Latest rows only"),
            ["PreferenceKind.MyMediaExcludes"] = (A, "libraries left out of the person's views (treated as access: whether a query honours it depends on the endpoint)"),
            ["PreferenceKind.GroupedFolders"] = (N, "display: how views are grouped"),
            ["PreferenceKind.BlockUnratedItems"] = (A, "parental: unrated items hidden"),
            ["PreferenceKind.OrderedViews"] = (N, "display: the order of views"),
            ["PreferenceKind.AllowedTags"] = (A, "parental: only items with these tags shown"),
        };

        /// <summary>"UserPolicy.X" / "UserConfiguration.X" → the <see cref="Entity"/> row it is saved as (its class).</summary>
        internal static readonly IReadOnlyDictionary<string, string> Sources = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["UserPolicy.AccessSchedules"] = "User.AccessSchedules",
            ["UserPolicy.AllowedTags"] = "PreferenceKind.AllowedTags",
            ["UserPolicy.AuthenticationProviderId"] = "User.AuthenticationProviderId",
            ["UserPolicy.BlockedChannels"] = "PreferenceKind.BlockedChannels",
            ["UserPolicy.BlockedMediaFolders"] = "PreferenceKind.BlockedMediaFolders",
            ["UserPolicy.BlockedTags"] = "PreferenceKind.BlockedTags",
            ["UserPolicy.BlockUnratedItems"] = "PreferenceKind.BlockUnratedItems",
            ["UserPolicy.EnableAllChannels"] = "PermissionKind.EnableAllChannels",
            ["UserPolicy.EnableAllDevices"] = "PermissionKind.EnableAllDevices",
            ["UserPolicy.EnableAllFolders"] = "PermissionKind.EnableAllFolders",
            ["UserPolicy.EnableAudioPlaybackTranscoding"] = "PermissionKind.EnableAudioPlaybackTranscoding",
            ["UserPolicy.EnableCollectionManagement"] = "PermissionKind.EnableCollectionManagement",
            ["UserPolicy.EnableContentDeletion"] = "PermissionKind.EnableContentDeletion",
            ["UserPolicy.EnableContentDeletionFromFolders"] = "PreferenceKind.EnableContentDeletionFromFolders",
            ["UserPolicy.EnableContentDownloading"] = "PermissionKind.EnableContentDownloading",
            ["UserPolicy.EnabledChannels"] = "PreferenceKind.EnabledChannels",
            ["UserPolicy.EnabledDevices"] = "PreferenceKind.EnabledDevices",
            ["UserPolicy.EnabledFolders"] = "PreferenceKind.EnabledFolders",
            ["UserPolicy.EnableLiveTvAccess"] = "PermissionKind.EnableLiveTvAccess",
            ["UserPolicy.EnableLiveTvManagement"] = "PermissionKind.EnableLiveTvManagement",
            ["UserPolicy.EnableLyricManagement"] = "PermissionKind.EnableLyricManagement",
            ["UserPolicy.EnableMediaConversion"] = "PermissionKind.EnableMediaConversion",
            ["UserPolicy.EnableMediaPlayback"] = "PermissionKind.EnableMediaPlayback",
            ["UserPolicy.EnablePlaybackRemuxing"] = "PermissionKind.EnablePlaybackRemuxing",
            ["UserPolicy.EnablePublicSharing"] = "PermissionKind.EnablePublicSharing",
            ["UserPolicy.EnableRemoteAccess"] = "PermissionKind.EnableRemoteAccess",
            ["UserPolicy.EnableRemoteControlOfOtherUsers"] = "PermissionKind.EnableRemoteControlOfOtherUsers",
            ["UserPolicy.EnableSharedDeviceControl"] = "PermissionKind.EnableSharedDeviceControl",
            ["UserPolicy.EnableSubtitleManagement"] = "PermissionKind.EnableSubtitleManagement",
            ["UserPolicy.EnableSyncTranscoding"] = "PermissionKind.EnableSyncTranscoding",
            ["UserPolicy.EnableUserPreferenceAccess"] = "User.EnableUserPreferenceAccess",
            ["UserPolicy.EnableVideoPlaybackTranscoding"] = "PermissionKind.EnableVideoPlaybackTranscoding",
            ["UserPolicy.ForceRemoteSourceTranscoding"] = "PermissionKind.ForceRemoteSourceTranscoding",
            ["UserPolicy.InvalidLoginAttemptCount"] = "User.InvalidLoginAttemptCount",
            ["UserPolicy.IsAdministrator"] = "PermissionKind.IsAdministrator",
            ["UserPolicy.IsDisabled"] = "PermissionKind.IsDisabled",
            ["UserPolicy.IsHidden"] = "PermissionKind.IsHidden",
            ["UserPolicy.LoginAttemptsBeforeLockout"] = "User.LoginAttemptsBeforeLockout",
            ["UserPolicy.MaxActiveSessions"] = "User.MaxActiveSessions",
            ["UserPolicy.MaxParentalRating"] = "User.MaxParentalRatingScore",
            ["UserPolicy.MaxParentalSubRating"] = "User.MaxParentalRatingSubScore",
            ["UserPolicy.PasswordResetProviderId"] = "User.PasswordResetProviderId",
            ["UserPolicy.RemoteClientBitrateLimit"] = "User.RemoteClientBitrateLimit",
            ["UserPolicy.SyncPlayAccess"] = "User.SyncPlayAccess",

            ["UserConfiguration.AudioLanguagePreference"] = "User.AudioLanguagePreference",
            ["UserConfiguration.CastReceiverId"] = "User.CastReceiverId",
            ["UserConfiguration.DisplayCollectionsView"] = "User.DisplayCollectionsView",
            ["UserConfiguration.DisplayMissingEpisodes"] = "User.DisplayMissingEpisodes",
            ["UserConfiguration.EnableLocalPassword"] = "User.EnableLocalPassword",
            ["UserConfiguration.EnableNextEpisodeAutoPlay"] = "User.EnableNextEpisodeAutoPlay",
            ["UserConfiguration.GroupedFolders"] = "PreferenceKind.GroupedFolders",
            ["UserConfiguration.HidePlayedInLatest"] = "User.HidePlayedInLatest",
            ["UserConfiguration.LatestItemsExcludes"] = "PreferenceKind.LatestItemExcludes",
            ["UserConfiguration.MyMediaExcludes"] = "PreferenceKind.MyMediaExcludes",
            ["UserConfiguration.OrderedViews"] = "PreferenceKind.OrderedViews",
            ["UserConfiguration.PlayDefaultAudioTrack"] = "User.PlayDefaultAudioTrack",
            ["UserConfiguration.RememberAudioSelections"] = "User.RememberAudioSelections",
            ["UserConfiguration.RememberSubtitleSelections"] = "User.RememberSubtitleSelections",
            ["UserConfiguration.SubtitleLanguagePreference"] = "User.SubtitleLanguagePreference",
            ["UserConfiguration.SubtitleMode"] = "User.SubtitleMode",
        };

        /// <summary>The class of one host member (a policy or configuration property takes its source's); null when nobody classified it.</summary>
        /// <param name="type">The type's simple name.</param>
        /// <param name="member">The property or enum member.</param>
        /// <returns>The class, or null.</returns>
        internal static Role? RoleOf(string type, string member)
        {
            var key = type + "." + member;
            if (type is "UserPolicy" or "UserConfiguration") return Sources.TryGetValue(key, out var source) && Entity.TryGetValue(source, out var hit) ? hit.Role : null;
            return Entity.TryGetValue(key, out var row) ? row.Role : null;
        }

        /// <summary>The members of <paramref name="rows"/> (a host list's type and member columns) nobody classified.</summary>
        /// <param name="rows">Type and member of each host property or enum member.</param>
        /// <returns>"Type.Member" of each unclassified one.</returns>
        internal static IReadOnlyList<string> Unclassified(IEnumerable<(string Type, string Member)> rows)
            => rows.Where(r => RoleOf(r.Type, r.Member) == null).Select(r => r.Type + "." + r.Member).ToList();

        // What the fingerprint reads, worked out once from the runtime types: every readable property except those
        // classified NotAccess (an unclassified one is read: deny by default).
        private static readonly PropertyInfo[] UserReads = Reads(typeof(JUser));
        private static readonly PropertyInfo[] PermissionReads = Reads(typeof(Permission));
        private static readonly PropertyInfo[] PreferenceReads = Reads(typeof(Preference));
        private static readonly Dictionary<Type, PropertyInfo[]> RowReads = new();
        private static readonly JsonSerializerOptions UnknownJson = new() { ReferenceHandler = ReferenceHandler.IgnoreCycles, MaxDepth = 8 };

        private static PropertyInfo[] Reads(Type type)
            => type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.CanRead && p.GetIndexParameters().Length == 0 && RoleOf(type.Name, p.Name) != Role.NotAccess)
                .OrderBy(p => p.Name, StringComparer.Ordinal)
                .ToArray();

        /// <summary>The fingerprint (see <see cref="UserAuthority.Fingerprint"/>).</summary>
        /// <param name="user">The user, as just read.</param>
        /// <returns>Every access-deciding fact, as one string.</returns>
        internal static string Fingerprint(JUser user)
        {
            var text = new StringBuilder(256);
            foreach (var property in UserReads)
            {
                text.Append(property.Name).Append('=');
                var value = property.GetValue(user);
                switch (property.Name)
                {
                    case nameof(JUser.Permissions):
                        // One entry per permission row whose kind isn't NotAccess, in kind order.
                        AppendRows(text, (value as IEnumerable)?.OfType<Permission>().Where(p => RoleOf("PermissionKind", p.Kind.ToString()) != Role.NotAccess), PermissionReads);
                        break;
                    case nameof(JUser.Preferences):
                        AppendRows(text, (value as IEnumerable)?.OfType<Preference>().Where(p => RoleOf("PreferenceKind", p.Kind.ToString()) != Role.NotAccess), PreferenceReads);
                        break;
                    default:
                        AppendValue(text, value);
                        break;
                }

                text.Append('\u001e');
            }

            return text.ToString();
        }

        private static void AppendRows<T>(StringBuilder text, IEnumerable<T>? rows, PropertyInfo[] reads)
        {
            if (rows == null) return;
            var each = rows.Select(row => Row(row!, reads)).OrderBy(r => r, StringComparer.Ordinal);
            foreach (var row in each) text.Append(row).Append('\u001f');
        }

        private static string Row(object row, PropertyInfo[] reads)
        {
            var text = new StringBuilder();
            foreach (var property in reads)
            {
                text.Append(property.Name).Append(':');
                var value = property.GetValue(row);
                // A preference holds a set ("a,b,c" as Jellyfin joins it, in whatever order it was saved): compared
                // without its order.
                if (row is Preference && property.Name == nameof(Preference.Value) && value is string set)
                {
                    text.Append(string.Join(',', set.Split(',').OrderBy(v => v, StringComparer.Ordinal)));
                }
                else
                {
                    AppendValue(text, value);
                }

                text.Append(';');
            }

            return text.ToString();
        }

        private static void AppendValue(StringBuilder text, object? value)
        {
            switch (value)
            {
                case null:
                    text.Append('␀');
                    return;
                case string s:
                    text.Append(s);
                    return;
                case bool b:
                    text.Append(b ? '1' : '0');
                    return;
                case IFormattable f when value.GetType().IsPrimitive || value is Enum or Guid or DateTime or DateTimeOffset or decimal:
                    text.Append(f.ToString(null, CultureInfo.InvariantCulture));
                    return;
                case IEnumerable rows when value is not string:
                    // A collection of rows (access schedules, or one a newer Jellyfin adds): each by its type's classified
                    // properties, in a stable order.
                    var items = rows.Cast<object?>().Select(r => r == null ? "␀" : Simple(r) ?? Row(r, RowReadsOf(r.GetType())));
                    foreach (var item in items.OrderBy(i => i, StringComparer.Ordinal)) text.Append(item).Append('\u001f');
                    return;
                default:
                    // A property nobody classified, of a type this doesn't know: its whole value.
                    try
                    {
                        text.Append(JsonSerializer.Serialize(value, value.GetType(), UnknownJson));
                    }
                    catch (Exception)
                    {
                        // Can't be compared: never equal, so nothing keyed by it is reused.
                        text.Append(Guid.NewGuid().ToString("N"));
                    }

                    return;
            }
        }

        private static string? Simple(object value)
        {
            if (value is string or bool || value.GetType().IsPrimitive || value is Enum or Guid or DateTime or DateTimeOffset or decimal)
            {
                var text = new StringBuilder();
                AppendValue(text, value);
                return text.ToString();
            }

            return null;
        }

        private static PropertyInfo[] RowReadsOf(Type type)
        {
            lock (RowReads)
            {
                if (!RowReads.TryGetValue(type, out var reads)) RowReads[type] = reads = Reads(type);
                return reads;
            }
        }
    }
}
