using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>The add settings Jellyfin Enhanced sends with a new title, checked against the instance.</summary>
    /// <param name="ProfileId">Quality profile id the instance lists.</param>
    /// <param name="RootFolder">Root folder path the instance lists (and can write to).</param>
    /// <param name="Tags">Tag ids the instance has.</param>
    /// <param name="MinimumAvailability">Radarr minimum availability (announced, inCinemas or released).</param>
    /// <param name="SeriesType">Sonarr series type (standard, daily or anime).</param>
    public sealed record ArrAddDefaults(int ProfileId, string RootFolder, int[] Tags, string MinimumAvailability, string SeriesType);

    /// <summary>The outcome of checking add settings: the settings, or why they can't be used.</summary>
    /// <param name="Defaults">The checked settings, when usable.</param>
    /// <param name="Reason">Null, <c>defaults_unverified</c> (no current facts), <c>invalid_defaults</c>
    /// (a required value is missing), or <c>invalid_choice</c> (a supplied/saved value is unusable; Message names its field).</param>
    /// <param name="Message">Administrator wording (no paths beyond the instance's own folders, never a key).</param>
    public sealed record ArrAddCheck(ArrAddDefaults? Defaults, string? Reason, string Message);

    /// <summary>
    /// How Jellyfin Enhanced picks and checks the quality profile, root folder and tags for a title it
    /// adds to Sonarr or Radarr. Every value comes from the instance's saved add defaults or an
    /// administrator's explicit choice, never "the first one the arr lists", and must be present in a
    /// current system snapshot (one that loaded without an error and is within its freshness target).
    /// </summary>
    public static class ArrAddRules
    {
        /// <summary>Radarr's accepted minimum availability values.</summary>
        public static readonly IReadOnlyList<string> Availability = new[] { "announced", "inCinemas", "released" };

        /// <summary>Sonarr's series types.</summary>
        public static readonly IReadOnlyList<string> SeriesTypes = new[] { "standard", "daily", "anime" };

        /// <summary>
        /// The instance's system facts (profiles, root folders, disk) as current as the store can make
        /// them: a held snapshot past its freshness target, or one whose last read failed, is read again
        /// first. The caller refuses anything still stale, missing or failed.
        /// </summary>
        public static async Task<ArrSnapshotRead<ArrSystemSnapshot>> FreshSystemAsync(ArrStateStore store, ArrConnection instance, CancellationToken ct)
        {
            var read = await store.GetSystemAsync(instance, ct).ConfigureAwait(false);
            if (read.Value != null && read.Error == null && !read.Stale) return read;
            await store.RefreshForEventAsync(instance.Id, ArrSnapshotKind.System, force: read.Value == null).ConfigureAwait(false);
            return await store.GetSystemAsync(instance, ct).ConfigureAwait(false);
        }

        /// <summary>
        /// Checks the add settings for <paramref name="instance"/>: the administrator's
        /// <paramref name="profileId"/>/<paramref name="rootFolder"/> when given, else the instance's
        /// saved defaults. <paramref name="tags"/> is the instance's tag list (null when it couldn't be
        /// read: then saved tags can't be checked and are refused).
        /// </summary>
        public static ArrAddCheck Check(ArrConnection instance, ArrSnapshotRead<ArrSystemSnapshot> system, IReadOnlyDictionary<int, string>? tags, int? profileId = null, string? rootFolder = null, ArrInstanceDefaults? ownedSettings = null)
        {
            var name = instance.Name;
            if (system.Value == null || system.Error != null || system.Stale)
            {
                return new ArrAddCheck(null, "defaults_unverified", $"{name}'s quality profiles and root folders could not be read just now, so the add settings can't be checked.");
            }
            var saved = instance.Defaults;
            var profile = ownedSettings != null ? profileId : profileId ?? saved?.QualityProfileId;
            var root = ownedSettings != null ? rootFolder : rootFolder ?? saved?.RootFolderPath;
            if (profile == null || root == null)
            {
                return new ArrAddCheck(null, ownedSettings != null ? "invalid_choice" : "invalid_defaults", $"{name} needs a quality profile and root folder for adding titles. Choose them in Manage → Add to, or set the instance's add defaults.");
            }
            if (!system.Value.QualityProfiles.Any(p => p.Id == profile))
            {
                return new ArrAddCheck(null, "invalid_choice", $"{name} no longer has the quality profile chosen for adding titles (id {profile}).");
            }
            var folder = system.Value.RootFolders.FirstOrDefault(r => r.Path != null && BridgePaths.Safe(root!) && BridgePaths.SamePath(r.Path, root!));
            if (folder == null)
            {
                return new ArrAddCheck(null, "invalid_choice", $"{name} doesn't list the root folder chosen for adding titles.");
            }
            if (folder.Accessible == false)
            {
                return new ArrAddCheck(null, "invalid_choice", $"{name} reports its root folder {folder.Path} as not accessible.");
            }
            var settings = ownedSettings ?? saved;
            var wanted = (settings?.Tags ?? new List<int>()).Distinct().ToArray();
            if (wanted.Length > 0 && (tags == null || wanted.Any(t => !tags.ContainsKey(t))))
            {
                return new ArrAddCheck(null, tags == null ? "defaults_unverified" : "invalid_choice", $"{name} doesn't have every tag set in its add defaults.");
            }
            var availability = Availability.FirstOrDefault(a => string.Equals(a, settings?.MinimumAvailability, StringComparison.OrdinalIgnoreCase)) ?? "released";
            var seriesType = SeriesTypes.FirstOrDefault(s => string.Equals(s, settings?.SeriesType, StringComparison.OrdinalIgnoreCase))
                ?? (instance.Role == ArrInstanceRole.Anime ? "anime" : "standard");
            return new ArrAddCheck(new ArrAddDefaults(profile.Value, ownedSettings != null ? root : folder.Path!, wanted, availability, seriesType), null, string.Empty);
        }
    }
}
