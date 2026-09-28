using System;
using System.Collections.Generic;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Shared "arm many titles for many users" path used by the two bulk
    // auto-enable features: the library-add batcher (SpoilerLibraryAddAutoEnabler)
    // and the admin-triggered "apply to existing titles" run
    // (SpoilerExistingTitlesApplier). Both must agree on:
    //
    //   * scope      — SpoilerAutoEnableFilter (content type + library allow-list)
    //   * audience   — every user, disabled accounts included (maintenance
    //                  mode disables accounts for exactly the window in which
    //                  new media tends to be imported)
    //   * access     — the user's library-access policy (EnableAllFolders or
    //                  the EnabledFolders allow-list), checked in memory
    //                  rather than with an N x U GetItemById probe
    //   * writes     — ONE locked read-modify-write of spoilerblur.json per
    //                  user per batch, never touching an existing entry
    internal static class SpoilerAutoEnableArmer
    {
        /// <summary>Why a title was not armed for a particular user.</summary>
        internal enum SkipReason
        {
            None,
            Watched,
            Started,
        }

        /// <summary>An in-scope Series or Movie, resolved once per batch.</summary>
        internal sealed class Candidate
        {
            public Guid Id;
            public string IdN = string.Empty;
            public string Name = string.Empty;
            public bool IsSeries;
            public List<Guid> LibraryIds = new();
        }

        /// <summary>Per-user outcome of one <see cref="ArmForUser"/> call.</summary>
        internal readonly record struct ArmResult(int Series, int Movies, int AlreadyArmed, int SkippedWatched, int SkippedStarted)
        {
            public int Armed => Series + Movies;
        }

        /// <summary>
        /// Every user on the server, disabled accounts included (see the class
        /// comment). <paramref name="anyRestrictedUser"/> is true when at least
        /// one user is limited to specific libraries, i.e. when candidates need
        /// their library ids resolved for the per-user access check.
        /// </summary>
        public static List<User> GetTargetUsers(IUserManager userManager, out bool anyRestrictedUser)
        {
            anyRestrictedUser = false;
            var users = new List<User>();
            foreach (var user in userManager.GetAllUsers())
            {
                if (!user.HasPermission(PermissionKind.EnableAllFolders)) anyRestrictedUser = true;
                users.Add(user);
            }
            return users;
        }

        /// <summary>
        /// Resolves <paramref name="item"/> into a candidate if it is a Series or
        /// Movie inside the configured auto-enable scope; null otherwise.
        /// Library resolution walks the parent chain, so it only runs when
        /// <paramref name="needLibraryIds"/> says something needs the answer.
        /// </summary>
        public static Candidate? TryBuildCandidate(
            ILibraryManager libraryManager,
            BaseItem? item,
            PluginConfiguration cfg,
            HashSet<Guid>? allowedLibraries,
            bool needLibraryIds)
        {
            if (item is not Series && item is not Movie) return null;
            var isSeries = item is Series;
            if (!SpoilerAutoEnableFilter.AllowsType(cfg, isSeries)) return null;

            var libraryIds = needLibraryIds
                ? SpoilerAutoEnableFilter.GetLibraryIds(libraryManager, item)
                : new List<Guid>();
            if (!SpoilerAutoEnableFilter.AllowsLibrary(allowedLibraries, libraryIds)) return null;

            return new Candidate
            {
                Id = item.Id,
                IdN = item.Id.ToString("N"),
                Name = item.Name ?? string.Empty,
                IsSeries = isSeries,
                LibraryIds = libraryIds,
            };
        }

        /// <summary>The candidates sitting in a library <paramref name="user"/> has access to.</summary>
        public static List<Candidate> VisibleTo(User user, IReadOnlyList<Candidate> candidates)
        {
            if (user.HasPermission(PermissionKind.EnableAllFolders)) return new List<Candidate>(candidates);

            var enabledFolders = new HashSet<Guid>(user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders));
            var visible = new List<Candidate>();
            if (enabledFolders.Count == 0) return visible;
            foreach (var c in candidates)
            {
                if (SpoilerAutoEnableFilter.AllowsLibrary(enabledFolders, c.LibraryIds)) visible.Add(c);
            }
            return visible;
        }

        /// <summary>
        /// Arms <paramref name="visible"/> for one user in a single locked
        /// read-modify-write of their spoilerblur.json. Titles the user already
        /// has an entry for are left untouched (never clobbers an EnabledAt,
        /// and the Series/Movies lists are the only record of a user's choice).
        /// <paramref name="skip"/> is consulted only for titles not already armed.
        /// With <paramref name="dryRun"/> the same counts are produced but
        /// nothing is written. Throws what RmwUserConfiguration throws (e.g.
        /// InvalidDataException for a corrupt file); callers handle per user.
        /// </summary>
        public static ArmResult ArmForUser(
            UserConfigurationManager configManager,
            string userKey,
            IReadOnlyList<Candidate> visible,
            Func<Candidate, SkipReason>? skip,
            bool dryRun,
            string enabledAt)
        {
            int series = 0, movies = 0, already = 0, watched = 0, started = 0;
            configManager.RmwUserConfiguration<UserSpoilerBlur>(userKey, SpoilerBlurImageFilter.SpoilerBlurFileName, state =>
            {
                if (state == null) return 0;
                foreach (var c in visible)
                {
                    if (c.IsSeries ? state.Series.ContainsKey(c.IdN) : state.Movies.ContainsKey(c.IdN))
                    {
                        already++;
                        continue;
                    }

                    var reason = skip?.Invoke(c) ?? SkipReason.None;
                    if (reason == SkipReason.Watched) { watched++; continue; }
                    if (reason == SkipReason.Started) { started++; continue; }

                    if (c.IsSeries)
                    {
                        series++;
                        if (!dryRun)
                        {
                            state.Series[c.IdN] = new SpoilerBlurSeriesEntry
                            {
                                SeriesId = c.IdN,
                                SeriesName = c.Name,
                                EnabledAt = enabledAt,
                            };
                        }
                    }
                    else
                    {
                        movies++;
                        if (!dryRun)
                        {
                            state.Movies[c.IdN] = new SpoilerBlurMovieEntry
                            {
                                MovieId = c.IdN,
                                MovieName = c.Name,
                                EnabledAt = enabledAt,
                            };
                        }
                    }
                }
                // 0 = no save: a dry run (or nothing new) never touches the file.
                return dryRun ? 0 : series + movies;
            });
            return new ArmResult(series, movies, already, watched, started);
        }
    }
}
