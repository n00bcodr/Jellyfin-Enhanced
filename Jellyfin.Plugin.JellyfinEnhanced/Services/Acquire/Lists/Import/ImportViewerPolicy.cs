using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// One viewer's own title rules as the import review applies them (D46: imported titles get the policy absent titles
    /// get elsewhere): titles they hid with Hidden Content (<see cref="HiddenKeys"/>, <c>movie:tmdb:N</c> /
    /// <c>tv:tmdb:N</c>) and titles they guard with Spoiler Guard (<see cref="SpoilerGuarded"/>). Parental limits and
    /// library access are not here: the resolver applies those first (they hide; these only mark or strip).
    /// </summary>
    /// <param name="HiddenKeys">Hidden title keys.</param>
    /// <param name="SpoilerGuarded">Whether the viewer guards a title, asked with its completed identity (every id it is known by).</param>
    public sealed record ImportViewer(IReadOnlySet<string> HiddenKeys, Func<CompletedIdentity, bool> SpoilerGuarded)
    {
        /// <summary>No rules (unknown viewer state never hides anything here; parental checks fail closed elsewhere).</summary>
        public static readonly ImportViewer None = new(new HashSet<string>(StringComparer.Ordinal), _ => false);

        /// <summary>
        /// Applies the rules to one result: a hidden candidate is marked (never pre-selected: the match is capped at low
        /// with reason <c>hidden</c>), a guarded one loses its overview and episode titles. Nothing else changes.
        /// </summary>
        /// <param name="result">A resolved entry (changed in place).</param>
        public void Project(ResolvedEntryDto result)
        {
            foreach (var candidate in result.Candidates.Append(result.Match).OfType<ImportCandidateDto>().Distinct())
            {
                Project(candidate);
            }

            if (result.Match?.Hidden == true && !result.Reasons.Contains("hidden"))
            {
                result.Reasons.Add("hidden");
                result.Confidence = ImportScoring.Cap(result.Confidence, ImportScoring.Levels.Low);
            }
        }

        /// <summary>
        /// Applies the rules to one candidate (in place). Spoiler Guard takes the candidate's completed identity; a
        /// candidate without one is guarded (fails closed). A guarded candidate loses every title-level text a provider
        /// fills (review round 5, 4c2-R5-2: the inventory): its overview, its season's name (Jellyfin's own Spoiler Guard
        /// shows "Season N") and its episodes' titles. Its title, year, dates, poster and numbers stay.
        /// </summary>
        /// <param name="candidate">Candidate.</param>
        public void Project(ImportCandidateDto candidate)
        {
            if (HiddenKeys.Contains(candidate.MediaType + ":tmdb:" + candidate.TmdbId.ToString(CultureInfo.InvariantCulture)))
            {
                candidate.Hidden = true;
            }

            if (candidate.Identity is not { } identity || SpoilerGuarded(identity))
            {
                candidate.SpoilerGuarded = true;
                candidate.Overview = null;
                if (candidate.Season != null)
                {
                    candidate.Season.Name = null;
                }

                foreach (var episode in candidate.Episodes ?? new List<ImportEpisodeInfoDto>())
                {
                    episode.Title = null;
                }
            }
        }

        /// <summary>
        /// Applies the rules to one entry of a list review (review round 5, 4c2-R5-2), ordinary or exact, in place: when the
        /// viewer guards the title (asked with its completed identity; none: guarded, fails closed), every title-level text
        /// a provider fills into the entry goes: its note (a list's own note; an IMDb episode row's episode title), its
        /// episode title, its alternatives' titles; and its prepared resolution is projected like any other. The entry is
        /// the review's own copy: the source rows it was built from are never changed.
        /// </summary>
        /// <param name="entry">The entry.</param>
        /// <param name="identity">The completed identity of its title.</param>
        public void Project(ImportEntryDto entry, CompletedIdentity? identity)
        {
            if (entry.Prepared != null)
            {
                Project(entry.Prepared);
            }

            if (identity != null && !SpoilerGuarded(identity))
            {
                return;
            }

            entry.Note = null;
            entry.EpisodeTitle = null;
            foreach (var alternative in entry.Alternatives ?? new List<ImportAlternativeDto>())
            {
                alternative.Title = null;
            }
        }
    }

    /// <summary>Reads a viewer's <see cref="ImportViewer"/> rules.</summary>
    public interface IImportViewerPolicy
    {
        /// <summary>The viewer's rules now (read per request).</summary>
        /// <param name="viewer">The caller.</param>
        /// <returns>Rules.</returns>
        ImportViewer For(User viewer);
    }

    /// <summary>
    /// <see cref="IImportViewerPolicy"/> over each person's JE settings: Hidden Content's global hides (while Hidden Content
    /// is on for them) and Spoiler Guard (while the feature is on): a title is guarded when the viewer turned it on before
    /// it arrived (a pending TMDB entry) or guards a library copy of it they can open, found under every id of its completed
    /// identity (a copy carrying only its TVDB or IMDb id guards it too; 4c2-R3-6). A settings file that can't be read
    /// counts as "no rules": the review then shows titles as any search does, and parental limits still apply.
    /// </summary>
    public sealed class UserImportViewerPolicy : IImportViewerPolicy
    {
        private readonly UserConfigurationManager _users;
        private readonly SpoilerUserResolver? _spoilers;
        private readonly IListHost _host;
        private readonly Logger _logger;

        /// <summary>Creates the policy (DI).</summary>
        /// <param name="users">Per-person settings.</param>
        /// <param name="host">Jellyfin seam (library copies the viewer can open).</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="spoilers">Spoiler Guard's per-person state (absent: no spoiler rules).</param>
        public UserImportViewerPolicy(UserConfigurationManager users, IListHost host, Logger logger, SpoilerUserResolver? spoilers = null)
        {
            _users = users;
            _host = host;
            _logger = logger;
            _spoilers = spoilers;
        }

        /// <inheritdoc />
        public ImportViewer For(User viewer)
        {
            IReadOnlySet<string> hidden;
            try
            {
                var data = _users.GetUserConfiguration<UserHiddenContent>(viewer.Id.ToString("N", CultureInfo.InvariantCulture), DiscoverService.HiddenContentFile);
                hidden = DiscoverService.GlobalHiddenKeys(data).Where(k => k.Contains(":tmdb:", StringComparison.Ordinal)).ToHashSet(StringComparer.Ordinal);
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] Hidden Content of {viewer.Id:N} unreadable for the import review: {ex.Message}");
                hidden = new HashSet<string>(StringComparer.Ordinal);
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_spoilers == null || config?.SpoilerBlurEnabled != true)
            {
                return new ImportViewer(hidden, _ => false);
            }

            UserSpoilerBlur state;
            try
            {
                state = _spoilers.LoadUserState(new DefaultHttpContext(), viewer.Id);
            }
            catch (Exception ex)
            {
                // Unknown: guard everything (Spoiler Guard fails closed: nothing a spoiler could be in is shown).
                _logger.Debug($"[Lists] Spoiler Guard state of {viewer.Id:N} unreadable for the import review: {ex.Message}");
                return new ImportViewer(hidden, _ => true);
            }

            var spoilers = _spoilers;
            var memo = new Dictionary<string, bool>(StringComparer.Ordinal);
            return new ImportViewer(hidden, identity =>
            {
                var key = identity.Text();
                if (memo.TryGetValue(key, out var known))
                {
                    return known;
                }

                var guarded = Guarded(state, spoilers, viewer, identity);
                memo[key] = guarded;
                return guarded;
            });
        }

        private bool Guarded(UserSpoilerBlur state, SpoilerUserResolver spoilers, User viewer, CompletedIdentity identity)
        {
            if (identity.Tmdb is int tmdb && state.PendingTmdb.ContainsKey((identity.Movie ? "movie:" : "tv:") + tmdb.ToString(CultureInfo.InvariantCulture)))
            {
                return true;
            }

            if (state.Series.Count == 0 && state.Movies.Count == 0 && state.Collections.Count == 0)
            {
                return false;
            }

            try
            {
                // The library copies under every id of the completed identity (4c2-R3-6).
                return identity.Movie
                    ? _host.FindMovies(identity.Tmdb, identity.Imdb, viewer).Any(id => spoilers.IsMovieInSpoilerScope(state, id))
                    : _host.FindSeries(identity.Tmdb, identity.Tvdb, identity.Imdb, viewer).Any(id => state.Series.ContainsKey(id.ToString("N", CultureInfo.InvariantCulture)));
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] Spoiler Guard library check of {identity.Text()} failed: {ex.Message}");
                return true;
            }
        }
    }
}
