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
    /// <param name="SpoilerGuarded">Whether the viewer guards a title (media type, TMDB id).</param>
    public sealed record ImportViewer(IReadOnlySet<string> HiddenKeys, Func<string, int, bool> SpoilerGuarded)
    {
        /// <summary>No rules (unknown viewer state never hides anything here; parental checks fail closed elsewhere).</summary>
        public static readonly ImportViewer None = new(new HashSet<string>(StringComparer.Ordinal), (_, _) => false);

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

        /// <summary>Applies the rules to one candidate (in place).</summary>
        /// <param name="candidate">Candidate.</param>
        public void Project(ImportCandidateDto candidate)
        {
            if (HiddenKeys.Contains(candidate.MediaType + ":tmdb:" + candidate.TmdbId.ToString(CultureInfo.InvariantCulture)))
            {
                candidate.Hidden = true;
            }

            if (SpoilerGuarded(candidate.MediaType, candidate.TmdbId))
            {
                candidate.SpoilerGuarded = true;
                candidate.Overview = null;
                foreach (var episode in candidate.Episodes ?? new List<ImportEpisodeInfoDto>())
                {
                    episode.Title = null;
                }
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
    /// it arrived (a pending TMDB entry) or guards a library copy of it they can open. A settings file that can't be read
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
                return new ImportViewer(hidden, (_, _) => false);
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
                return new ImportViewer(hidden, (_, _) => true);
            }

            var spoilers = _spoilers;
            var memo = new Dictionary<(string, int), bool>();
            return new ImportViewer(hidden, (mediaType, tmdbId) =>
            {
                if (memo.TryGetValue((mediaType, tmdbId), out var known))
                {
                    return known;
                }

                var guarded = Guarded(state, spoilers, viewer, mediaType, tmdbId);
                memo[(mediaType, tmdbId)] = guarded;
                return guarded;
            });
        }

        private bool Guarded(UserSpoilerBlur state, SpoilerUserResolver spoilers, User viewer, string mediaType, int tmdbId)
        {
            var pending = (mediaType == "movie" ? "movie:" : "tv:") + tmdbId.ToString(CultureInfo.InvariantCulture);
            if (state.PendingTmdb.ContainsKey(pending))
            {
                return true;
            }

            if (state.Series.Count == 0 && state.Movies.Count == 0 && state.Collections.Count == 0)
            {
                return false;
            }

            try
            {
                return mediaType == "movie"
                    ? _host.FindMovies(tmdbId, null, viewer).Any(id => spoilers.IsMovieInSpoilerScope(state, id))
                    : _host.FindSeries(tmdbId, null, null, viewer).Any(id => state.Series.ContainsKey(id.ToString("N", CultureInfo.InvariantCulture)));
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] Spoiler Guard library check of {mediaType}/{tmdbId} failed: {ex.Message}");
                return true;
            }
        }
    }
}
